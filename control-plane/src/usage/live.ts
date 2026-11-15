/**
 * What a Project's Resources use now, for the API (ARCHITECTURE.md,
 * decision 124): its pods from Kubernetes, their CPU, memory and disk from
 * the platform's Prometheus, a Bucket's bytes from Garage. Not what is
 * billed: that is the metering pass (meter.ts), which counts whole hours.
 *
 * - CPU: the CPU agent's per-pod total (decision 115) as a rate over two
 *   minutes, so it is the same count metering bills.
 * - Memory: the working set of the pod's cgroup, which is what the kernel
 *   holds against its limit.
 * - A Database instance's disk: its volume's used bytes, or, where the
 *   volumes are directories of the node's disk and report that disk's use
 *   (`shared`, a single node's local-path), Postgres's databases plus its
 *   WAL, which leaves out temporary files.
 *
 * Without Prometheus, or when it does not answer, the pods are still
 * listed and nothing is measured.
 */
import {
    type Bucket,
    type Database,
    type Instance,
    type InstanceRole,
    type InstanceState,
    type Job,
    type Measured,
    type ProjectUsage,
    type ResourceKind,
    type ResourceUsage,
    type Service,
    type Site,
    UUID,
    projectNamespace,
} from '@openupstream/sdk';
import type { PodInfo } from '../kube.js';
import type { PrometheusQuery, PrometheusSample } from '../prometheus.js';
import { type Result, ok } from '../result.js';

const UUID_PATTERN = UUID.source.replace(/^\^|\$$/g, '');
/** `db-<id>-1`, `db-<id>-pooler-…`, `svc-<id>-…`, `job-<id>-…`: the Resource's kind and id, and the rest. */
const POD = new RegExp(`^(db|svc|job)-(${UUID_PATTERN})-(.+)$`);
const KIND: Readonly<Record<string, ResourceKind>> = { db: 'database', svc: 'service', job: 'job' };

const MIB = 2 ** 20;
const GIB = 2 ** 30;

/** The pods' selector: every pod of a Project's Resources carries its id. */
export const projectPods = (projectId: string): string => `openupstream.io/project-id=${projectId}`;

/** Cores per pod, averaged over the last two minutes. */
export const cpuQuery = (namespace: string): string => `sum by (pod) (rate(openupstream_pod_cpu_usage_seconds_total{namespace="${namespace}"}[2m]))`;
/** The pod cgroup's working set: the series without a container. */
export const memoryQuery = (namespace: string): string =>
    `sum by (pod) (container_memory_working_set_bytes{namespace="${namespace}", container="", image=""})`;
/** Used bytes per Database instance, whose volume carries the pod's name. */
export const diskQuery = (namespace: string, volumes: 'dedicated' | 'shared'): string =>
    volumes === 'dedicated'
        ? `max by (persistentvolumeclaim) (kubelet_volume_stats_used_bytes{namespace="${namespace}", persistentvolumeclaim=~"db-.*"})`
        : `sum by (pod) (cnpg_pg_database_size_bytes{namespace="${namespace}"}) + on (pod) sum by (pod) (cnpg_collector_pg_wal{namespace="${namespace}", value="size"})`;

/** Per pod; undefined: nothing was measured. */
export interface Measurements {
    readonly cpuCores: ReadonlyMap<string, number>;
    readonly memoryBytes: ReadonlyMap<string, number>;
    readonly diskBytes: ReadonlyMap<string, number>;
}

export interface ProjectRows {
    readonly databases: readonly Database[];
    readonly services: readonly Service[];
    readonly jobs: readonly Job[];
    readonly buckets: readonly Bucket[];
}

const stateOf = (pod: PodInfo): InstanceState => {
    if (pod.terminating === true) {
        return 'stopping';
    }
    if (pod.phase === 'Succeeded') {
        return 'succeeded';
    }
    if (pod.phase === 'Failed') {
        return 'failed';
    }
    if (pod.phase === 'Running') {
        return pod.containers.every((container) => container.state === 'running') ? 'running' : 'restarting';
    }
    return 'starting';
};

const ended = (instance: Instance): boolean => instance.state === 'succeeded' || instance.state === 'failed';

const sum = (values: readonly (number | null)[]): number | null => {
    const known = values.filter((value) => value !== null);
    return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
};

const largest = (values: readonly (number | null)[]): number | null => {
    const known = values.filter((value) => value !== null);
    return known.length === 0 ? null : Math.max(...known);
};

const round = (value: number | undefined): number | null => (value === undefined || !Number.isFinite(value) ? null : Math.round(value));

/**
 * Each Resource with its instances and what they use. `sites` gives a
 * pod's Site by its name; `bucketBytes` a Bucket's size by its id, where
 * Garage answered. Pods of no Resource in `rows` (one just deleted) are
 * left out.
 */
export function usageOf(
    rows: ProjectRows,
    pods: readonly PodInfo[],
    sites: ReadonlyMap<string, Site | null>,
    measurements: Measurements | undefined,
    bucketBytes: ReadonlyMap<string, number>,
): ResourceUsage[] {
    const instances = new Map<string, Instance[]>();
    for (const pod of pods) {
        const match = POD.exec(pod.name);
        if (match === null) {
            continue;
        }
        const [, prefix, id, rest] = match as unknown as [string, string, string, string];
        const kind = KIND[prefix] as ResourceKind;
        // CloudNativePG's own short-lived pods (`db-<id>-1-initdb-…`, `-join-…`) are not instances.
        const role: InstanceRole | undefined =
            kind === 'service' ? 'replica' : kind === 'job' ? 'run' : rest.startsWith('pooler-') ? 'pooler' : /^\d+$/.test(rest) ? 'database' : undefined;
        if (role === undefined) {
            continue;
        }
        const cores = measurements?.cpuCores.get(pod.name);
        const instance: Instance = {
            name: rest,
            role,
            site: sites.get(pod.name) ?? null,
            state: stateOf(pod),
            restarts: pod.containers.reduce((total, container) => total + container.restartCount, 0),
            startedAt: pod.startedAt?.toISOString() ?? null,
            cpuMillicores: round(cores === undefined ? undefined : cores * 1000),
            memoryBytes: round(measurements?.memoryBytes.get(pod.name)),
            storageBytes: role === 'database' ? round(measurements?.diskBytes.get(pod.name)) : null,
        };
        const key = `${kind} ${id}`;
        instances.set(key, [...(instances.get(key) ?? []), instance]);
    }
    const of = (kind: ResourceKind, id: string): Instance[] => [...(instances.get(`${kind} ${id}`) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    const used = (list: readonly Instance[], field: 'cpuMillicores' | 'memoryBytes'): number | null => sum(list.filter((instance) => !ended(instance)).map((instance) => instance[field]));
    const none: Measured = { used: null, allocated: null };

    return [
        ...rows.databases.map((database): ResourceUsage => {
            const list = of('database', database.id);
            // PgBouncers have no size of the customer's choosing: only the instances' memory is allocated.
            const members = list.filter((instance) => instance.role === 'database' && !ended(instance)).length;
            return {
                kind: 'database',
                id: database.id,
                name: database.name,
                cpuMillicores: { used: used(list, 'cpuMillicores'), allocated: null },
                memoryBytes: { used: used(list, 'memoryBytes'), allocated: database.memoryMb * MIB * Math.max(1, members) },
                storageBytes: { used: largest(list.map((instance) => instance.storageBytes)), allocated: database.storageGb * GIB },
                instances: list,
            };
        }),
        ...rows.services.map((service): ResourceUsage => {
            const list = of('service', service.id);
            return {
                kind: 'service',
                id: service.id,
                name: service.name,
                cpuMillicores: { used: used(list, 'cpuMillicores'), allocated: service.cpuMillicores * service.replicas },
                memoryBytes: { used: used(list, 'memoryBytes'), allocated: service.memoryMb * MIB * service.replicas },
                storageBytes: none,
                instances: list,
            };
        }),
        ...rows.jobs.map((job): ResourceUsage => {
            const list = of('job', job.id);
            const running = list.filter((instance) => !ended(instance)).length;
            return {
                kind: 'job',
                id: job.id,
                name: job.name,
                cpuMillicores: { used: used(list, 'cpuMillicores'), allocated: job.cpuMillicores * running },
                memoryBytes: { used: used(list, 'memoryBytes'), allocated: job.memoryMb * MIB * running },
                storageBytes: none,
                instances: list,
            };
        }),
        ...rows.buckets.map(
            (bucket): ResourceUsage => ({
                kind: 'bucket',
                id: bucket.id,
                name: bucket.name,
                cpuMillicores: none,
                memoryBytes: none,
                storageBytes: { used: bucketBytes.get(bucket.id) ?? null, allocated: null },
                instances: [],
            }),
        ),
    ];
}

const byLabel = (samples: readonly PrometheusSample[], label: string): Map<string, number> =>
    new Map(samples.flatMap((sample) => (sample.labels[label] === undefined ? [] : [[sample.labels[label], sample.value] as const])));

/** The three queries for a Project's namespace; an error when Prometheus does not answer one of them. */
export async function measure(prometheus: PrometheusQuery, projectId: string, volumes: 'dedicated' | 'shared'): Promise<Result<Measurements, string>> {
    const namespace = projectNamespace(projectId);
    const [cpu, memory, disk] = await Promise.all([prometheus(cpuQuery(namespace)), prometheus(memoryQuery(namespace)), prometheus(diskQuery(namespace, volumes))]);
    if (!cpu.ok) {
        return cpu;
    }
    if (!memory.ok) {
        return memory;
    }
    if (!disk.ok) {
        return disk;
    }
    return ok({
        cpuCores: byLabel(cpu.value, 'pod'),
        memoryBytes: byLabel(memory.value, 'pod'),
        diskBytes: byLabel(disk.value, volumes === 'dedicated' ? 'persistentvolumeclaim' : 'pod'),
    });
}

export const projectUsage = (measuredAt: Date, measured: boolean, resources: ResourceUsage[]): ProjectUsage => ({
    measuredAt: measuredAt.toISOString(),
    measured,
    resources,
});
