/**
 * What the control plane asks of Kubernetes: a Database's, a Service's and
 * a Job's state for the API, the log stream of their pods (decision 21), the deletes of the cleanup (decision 48: deleting is the control
 * plane's explicit step, never the operator's), and the Secrets it renders
 * from its encrypted store (decision 91), since it alone holds the
 * key-encryption key. Every other object is the operators' to create.
 */
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { ApiException, type KubeConfig, KubernetesObjectApi, Log, PatchStrategy } from '@kubernetes/client-node';
import {
    COMPUTE_SITE_LABEL,
    DEFAULT_SITE_LABEL,
    SITE_DESCRIPTION_ANNOTATION,
    SPEC_VERSION_ANNOTATION,
    ZONE_LABEL,
    type DatabaseState,
    type JobState,
    type ServiceState,
} from '@openupstream/sdk';
import type { NodeLabels } from './sites.js';
import { type Result, err, ok } from './result.js';

export interface ObjectRef {
    readonly apiVersion: string;
    readonly kind: string;
    readonly namespace?: string;
    readonly name: string;
}

/** The fields of a CloudNativePG Cluster's status that decide its state. */
export interface ClusterStatus {
    readonly instances: number;
    readonly readyInstances: number;
    readonly ready: boolean;
    /** The sizes its spec asks for (`resources.limits.memory`, `storage.size`); undefined when unreadable. */
    readonly memoryMb?: number | undefined;
    readonly storageGb?: number | undefined;
    /** Volumes CloudNativePG is still growing (`status.resizingPVC`). */
    readonly resizingVolumes?: number;
    /** CloudNativePG's phase, e.g. `Cluster in healthy state` or DISK_FULL_PHASE. */
    readonly phase?: string | undefined;
}

/**
 * CloudNativePG's phase once a volume is full: it stops the instance and
 * waits for the volume to grow, but does not grow the PVCs itself when the
 * Cluster's size rises (dev cluster, 2026-11-15).
 */
export const DISK_FULL_PHASE = 'Not enough disk space';

/**
 * How far back a Database's backups reach, from its ObjectStore's status
 * (the Barman Cloud plugin writes it after each backup and retention run).
 * Both undefined before the first base backup has finished.
 */
export interface RecoveryWindow {
    /** The earliest point a restore can reach: the end of the oldest base backup. */
    readonly firstRecoverabilityPoint: Date | undefined;
    readonly lastSuccessfulBackupTime: Date | undefined;
}

/** The fields of a Service's Deployment that decide its state. */
export interface DeploymentStatus {
    readonly replicas: number;
    readonly generation: number;
    readonly observedGeneration: number;
    readonly updatedReplicas: number;
    readonly availableReplicas: number;
    /** What the Services operator applied it from (serviceSpecVersion); undefined before it set one. */
    readonly specVersion: string | undefined;
}

/**
 * No Deployment yet, none from the row's current spec (`wantedVersion`),
 * none available, or a rollout under way: deploying; every replica
 * available on the current version: running; else degraded.
 */
export const serviceStateOf = (status: DeploymentStatus | undefined, wantedVersion: string): ServiceState => {
    if (status === undefined || status.specVersion !== wantedVersion || status.availableReplicas === 0) {
        return 'deploying';
    }
    if (status.observedGeneration < status.generation || status.updatedReplicas < status.replicas) {
        return 'deploying';
    }
    return status.availableReplicas >= status.replicas ? 'running' : 'degraded';
};

/** The fields of a Job's CronJob that decide its state, and what a One-off job is copied from. */
export interface CronJobStatus {
    /** What the Jobs operator applied it from (jobSpecVersion); undefined before it set one. */
    readonly specVersion: string | undefined;
    /** Owner of the runs started from it. */
    readonly uid: string;
    /** Its `spec.jobTemplate`, as Kubernetes returns it. */
    readonly jobTemplate: unknown;
}

/** Ready once the CronJob carries the row's current spec (`wantedVersion`): runs then start from it. */
export const jobStateOf = (status: CronJobStatus | undefined, wantedVersion: string): JobState =>
    status !== undefined && status.specVersion === wantedVersion ? 'ready' : 'deploying';

/** The control plane's field manager for server-side apply; the operators have their own. */
export const FIELD_MANAGER = 'openupstream-control-plane';

/** A Kubernetes Secret as the control plane renders it; `data` values are base64. */
export interface SecretManifest {
    readonly apiVersion: 'v1';
    readonly kind: 'Secret';
    readonly type: string;
    readonly metadata: { readonly name: string; readonly namespace: string; readonly labels: Readonly<Record<string, string>> };
    readonly data: Readonly<Record<string, string>>;
}

/** A container of a pod, as far as its logs go. */
export interface PodContainer {
    readonly name: string;
    readonly restartCount: number;
    /** `waiting` has no output yet; `running` and `terminated` have. */
    readonly state: 'waiting' | 'running' | 'terminated';
}

/** A pod, as far as its logs go. */
export interface PodInfo {
    readonly name: string;
    /** undefined before it is scheduled. */
    readonly nodeName: string | undefined;
    readonly containers: readonly PodContainer[];
    /** `Pending`, `Running`, `Succeeded`, `Failed` or `Unknown`; undefined when a caller has no use for it. */
    readonly phase?: string;
    readonly startedAt?: Date;
    /** Being deleted. */
    readonly terminating?: boolean;
}

/** What to read of one container's log; Kubernetes' own parameters, timestamps always on. */
export interface PodLogOptions {
    readonly follow: boolean;
    readonly previous: boolean;
    readonly tailLines?: number;
    /** RFC 3339; Kubernetes reads it to the second. */
    readonly sinceTime?: string;
}

export interface ControlPlaneKube {
    /** undefined when the Cluster does not exist (yet). */
    readCluster(namespace: string, name: string): Promise<Result<ClusterStatus | undefined, string>>;
    /** The recovery window of the archive of the Cluster `name` in its ObjectStore of that name; undefined when there is no ObjectStore. */
    readRecoveryWindow(namespace: string, name: string): Promise<Result<RecoveryWindow | undefined, string>>;
    /** undefined when the Deployment does not exist (yet). */
    readDeployment(namespace: string, name: string): Promise<Result<DeploymentStatus | undefined, string>>;
    /** undefined when the CronJob does not exist (yet). */
    readCronJob(namespace: string, name: string): Promise<Result<CronJobStatus | undefined, string>>;
    /** Creates a Kubernetes Job (a run) and returns it as created; `exists` when one of that name does already. */
    createJob(manifest: KubeJob): Promise<Result<KubeJob | 'exists', string>>;
    /** The Kubernetes Jobs in the namespace that carry the labels in `selector`. */
    listJobs(namespace: string, selector: string): Promise<Result<KubeJob[], string>>;
    /** Stops and deletes a Kubernetes Job with its pod; `not-found` when there is none. */
    deleteJob(namespace: string, name: string): Promise<Result<'deleted' | 'not-found', string>>;
    /** The pods in the namespace that carry the labels in `selector`. */
    listPods(namespace: string, selector: string): Promise<Result<PodInfo[], string>>;
    /**
     * Free bytes per node from TopoLVM's CSIStorageCapacity objects;
     * undefined when there are none (storage other than TopoLVM).
     */
    storageCapacity(): Promise<Result<Map<string, number> | undefined, string>>;
    /**
     * Memory a new pod could still request on the node: its allocatable
     * memory less what its running and pending pods request; undefined when
     * the node is gone.
     */
    memoryFree(nodeName: string): Promise<Result<number | undefined, string>>;
    /** Raises every PVC of the Cluster `name` asking for less than `storageGb` to it; the names it raised. */
    growVolumes(namespace: string, name: string, storageGb: number): Promise<Result<string[], string>>;
    /** The nodes holding the volumes of the Cluster `name` (its PVCs' selected node). */
    volumeNodes(namespace: string, name: string): Promise<Result<string[], string>>;
    /** The Site (zone label) of a node; undefined when it has none or is gone. */
    nodeSite(nodeName: string): Promise<Result<string | undefined, string>>;
    /** Every node's Site labels and description (ADR-0007). */
    listNodes(): Promise<Result<NodeLabels[], string>>;
    /**
     * One container's log, line by line, each starting with its RFC 3339
     * timestamp; ends with the log, or when `signal` aborts.
     */
    podLog(namespace: string, pod: string, container: string, options: PodLogOptions, signal: AbortSignal): Promise<Result<AsyncIterable<string>, string>>;
    /** Deletes an object; one that is already gone counts as deleted. */
    remove(ref: ObjectRef): Promise<Result<void, string>>;
    /**
     * Server-side apply of a Secret. `no-namespace` when its namespace does
     * not exist yet: the operators create it with the Project's first object.
     */
    applySecret(secret: SecretManifest): Promise<Result<'applied' | 'no-namespace', string>>;
}

/**
 * No Cluster yet, or no instance up: provisioning; a spec with other sizes
 * than the Database's (the operator has not applied a resize yet), or a
 * volume still growing: resizing; all instances up: ready; some: degraded. While CloudNativePG
 * restarts the instances for a new memory size, its Ready condition is
 * false, so that reads as degraded.
 */
export const stateOf = (status: ClusterStatus | undefined, wanted?: { readonly memoryMb: number; readonly storageGb: number }): DatabaseState => {
    if (status === undefined || status.readyInstances === 0) {
        return 'provisioning';
    }
    const differs = (applied: number | undefined, asked: number | undefined) => applied !== undefined && asked !== undefined && applied !== asked;
    if (differs(status.memoryMb, wanted?.memoryMb) || differs(status.storageGb, wanted?.storageGb) || (status.resizingVolumes ?? 0) > 0) {
        return 'resizing';
    }
    return status.ready && status.readyInstances >= status.instances ? 'ready' : 'degraded';
};

const UNITS: Readonly<Record<string, number>> = { '': 1, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, k: 1e3, M: 1e6, G: 1e9, T: 1e12 };

/** A Kubernetes quantity such as `15356Mi` in bytes; undefined for forms with a fraction or another suffix. */
export const bytesOf = (quantity: string): number | undefined => {
    const match = /^(\d+)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(quantity);
    const unit = UNITS[match?.[2] ?? ''];
    return match === null || unit === undefined ? undefined : Number(match[1]) * unit;
};

/** `512Mi` → 512, `10Gi` → 10: whole units only, as the operator writes them; undefined otherwise. */
export const quantityIn = (quantity: string | undefined, unit: 'Mi' | 'Gi'): number | undefined => {
    const bytes = quantity === undefined || !quantity.endsWith(unit) ? undefined : bytesOf(quantity);
    return bytes === undefined ? undefined : bytes / (UNITS[unit] as number);
};

/** A node's Site labels; the client may parse its creation time into a Date. */
export const nodeLabels = (metadata: {
    readonly name: string;
    readonly labels?: Record<string, string>;
    readonly annotations?: Record<string, string>;
    readonly creationTimestamp?: Date | string;
}): NodeLabels => ({
    name: metadata.name,
    site: metadata.labels?.[ZONE_LABEL],
    compute: metadata.labels?.[COMPUTE_SITE_LABEL] === 'true',
    default: metadata.labels?.[DEFAULT_SITE_LABEL] === 'true',
    description: metadata.annotations?.[SITE_DESCRIPTION_ANNOTATION],
    createdAt: metadata.creationTimestamp instanceof Date ? metadata.creationTimestamp.toISOString() : (metadata.creationTimestamp ?? ''),
});

/** TopoLVM's topology key: one CSIStorageCapacity per node. */
const TOPOLVM_NODE_LABEL = 'topology.topolvm.io/node';
/** Set by the scheduler on a PVC bound to a local volume: the node it lives on. */
const SELECTED_NODE_ANNOTATION = 'volume.kubernetes.io/selected-node';

/** The client sets no timeout; an API server in a dark Site must not hang a request. */
export const KUBE_CALL_TIMEOUT_MS = 10_000;

const NOT_FOUND = 404;
const CONFLICT = 409;

const within = <T>(call: Promise<T>, timeoutMs: number): Promise<Result<T, { status: number; message: string }>> => {
    const timedOut = new Promise<Result<T, { status: number; message: string }>>((resolve) => {
        setTimeout(() => resolve(err({ status: 0, message: `no answer within ${timeoutMs} ms` })), timeoutMs).unref();
    });
    const answered = call.then(
        (value) => ok(value),
        (error: unknown) =>
            err(
                error instanceof ApiException
                    ? { status: error.code, message: error.message }
                    : { status: 0, message: error instanceof Error ? error.message : String(error) },
            ),
    );
    return Promise.race([answered, timedOut]);
};

interface ClusterObject {
    apiVersion: string;
    kind: string;
    metadata: { name: string; namespace: string };
    spec?: { instances?: number; resources?: { limits?: { memory?: string } }; storage?: { size?: string } };
    status?: { readyInstances?: number; conditions?: { type: string; status: string }[]; resizingPVC?: string[]; phase?: string };
}

interface ObjectStoreObject {
    apiVersion: string;
    kind: string;
    metadata: { name: string; namespace: string };
    status?: { serverRecoveryWindow?: Record<string, { firstRecoverabilityPoint?: string; lastSuccessfulBackupTime?: string }> };
}

const dateOf = (value: string | undefined): Date | undefined => (value === undefined ? undefined : new Date(value));

interface DeploymentObject {
    apiVersion: string;
    kind: string;
    metadata: { name: string; namespace: string; generation?: number; annotations?: Record<string, string> };
    spec?: { replicas?: number };
    status?: { observedGeneration?: number; updatedReplicas?: number; availableReplicas?: number };
}

interface CronJobObject {
    apiVersion: string;
    kind: string;
    metadata: { name: string; namespace: string; uid?: string; annotations?: Record<string, string> };
    spec?: { jobTemplate?: unknown };
}

interface PodObject {
    metadata: { name: string; deletionTimestamp?: Date };
    spec?: {
        nodeName?: string;
        containers?: { name: string; resources?: { requests?: Record<string, string> } }[];
        initContainers?: { name: string; resources?: { requests?: Record<string, string> } }[];
        /** Set from the RuntimeClass (gVisor's) and counted by the scheduler. */
        overhead?: Record<string, string>;
    };
    status?: {
        phase?: string;
        startTime?: Date | string;
        containerStatuses?: { name: string; restartCount?: number; state?: { running?: unknown; terminated?: unknown; waiting?: unknown } }[];
    };
}


const memoryOf = (requests: Record<string, string> | undefined): number => bytesOf(requests?.['memory'] ?? '0') ?? 0;

/**
 * Memory the scheduler reserves for a pod: its containers' requests, or
 * its largest init container's if that is more, plus the RuntimeClass's
 * overhead.
 */
export const podMemoryRequest = (pod: Pick<PodObject, 'spec'>): number => {
    const containers = (pod.spec?.containers ?? []).reduce((sum, container) => sum + memoryOf(container.resources?.requests), 0);
    const init = Math.max(0, ...(pod.spec?.initContainers ?? []).map((container) => memoryOf(container.resources?.requests)));
    return Math.max(containers, init) + memoryOf(pod.spec?.overhead);
};

const podInfoOf = (pod: PodObject): PodInfo => ({
    name: pod.metadata.name,
    nodeName: pod.spec?.nodeName,
    containers: (pod.spec?.containers ?? []).map((container) => {
        const status = pod.status?.containerStatuses?.find((candidate) => candidate.name === container.name);
        return {
            name: container.name,
            restartCount: status?.restartCount ?? 0,
            state: status?.state?.running !== undefined ? 'running' : status?.state?.terminated !== undefined ? 'terminated' : 'waiting',
        };
    }),
    ...(pod.status?.phase === undefined ? {} : { phase: pod.status.phase }),
    ...(pod.status?.startTime === undefined ? {} : { startedAt: new Date(pod.status.startTime) }),
    terminating: pod.metadata.deletionTimestamp !== undefined,
});

/** A Kubernetes Job, a run of a Job: the fields the control plane writes and reads. */
export interface KubeJob {
    apiVersion: 'batch/v1';
    kind: 'Job';
    metadata: {
        name: string;
        namespace: string;
        labels?: Record<string, string>;
        annotations?: Record<string, string>;
        creationTimestamp?: Date;
        ownerReferences?: { apiVersion: string; kind: string; name: string; uid: string; controller?: boolean; blockOwnerDeletion?: boolean }[];
    };
    spec?: unknown;
    status?: {
        active?: number;
        ready?: number;
        startTime?: Date;
        completionTime?: Date;
        conditions?: { type: string; status: string; reason?: string; lastTransitionTime?: Date }[];
    };
}

export function controlPlaneKube(config: KubeConfig, { timeoutMs = KUBE_CALL_TIMEOUT_MS } = {}): ControlPlaneKube {
    const api = KubernetesObjectApi.makeApiClient(config);
    const logs = new Log(config);
    return {
        readCluster: async (namespace, name) => {
            const result = await within(
                api.read<ClusterObject>({ apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster', metadata: { name, namespace } }),
                timeoutMs,
            );
            if (!result.ok) {
                return result.error.status === NOT_FOUND ? ok(undefined) : err(result.error.message);
            }
            const cluster = result.value;
            return ok({
                instances: cluster.spec?.instances ?? 0,
                readyInstances: cluster.status?.readyInstances ?? 0,
                ready: (cluster.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
                memoryMb: quantityIn(cluster.spec?.resources?.limits?.memory, 'Mi'),
                storageGb: quantityIn(cluster.spec?.storage?.size, 'Gi'),
                resizingVolumes: cluster.status?.resizingPVC?.length ?? 0,
                phase: cluster.status?.phase,
            });
        },
        readRecoveryWindow: async (namespace, name) => {
            const result = await within(
                api.read<ObjectStoreObject>({ apiVersion: 'barmancloud.cnpg.io/v1', kind: 'ObjectStore', metadata: { name, namespace } }),
                timeoutMs,
            );
            if (!result.ok) {
                return result.error.status === NOT_FOUND ? ok(undefined) : err(result.error.message);
            }
            // One ObjectStore per Database, its server named like its Cluster.
            const window = result.value.status?.serverRecoveryWindow?.[name];
            return ok({
                firstRecoverabilityPoint: dateOf(window?.firstRecoverabilityPoint),
                lastSuccessfulBackupTime: dateOf(window?.lastSuccessfulBackupTime),
            });
        },
        readDeployment: async (namespace, name) => {
            const result = await within(
                api.read<DeploymentObject>({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace } }),
                timeoutMs,
            );
            if (!result.ok) {
                return result.error.status === NOT_FOUND ? ok(undefined) : err(result.error.message);
            }
            const deployment = result.value;
            return ok({
                replicas: deployment.spec?.replicas ?? 1,
                generation: deployment.metadata.generation ?? 0,
                observedGeneration: deployment.status?.observedGeneration ?? 0,
                updatedReplicas: deployment.status?.updatedReplicas ?? 0,
                availableReplicas: deployment.status?.availableReplicas ?? 0,
                specVersion: deployment.metadata.annotations?.[SPEC_VERSION_ANNOTATION],
            });
        },
        readCronJob: async (namespace, name) => {
            const result = await within(
                api.read<CronJobObject>({ apiVersion: 'batch/v1', kind: 'CronJob', metadata: { name, namespace } }),
                timeoutMs,
            );
            if (!result.ok) {
                return result.error.status === NOT_FOUND ? ok(undefined) : err(result.error.message);
            }
            return ok({
                specVersion: result.value.metadata.annotations?.[SPEC_VERSION_ANNOTATION],
                uid: result.value.metadata.uid ?? '',
                jobTemplate: result.value.spec?.jobTemplate,
            });
        },
        createJob: async (manifest) => {
            const result = await within(api.create(manifest), timeoutMs);
            if (!result.ok) {
                return result.error.status === CONFLICT ? ok('exists') : err(result.error.message);
            }
            return ok(result.value);
        },
        listJobs: async (namespace, selector) => {
            const result = await within(api.list<KubeJob>('batch/v1', 'Job', namespace, undefined, undefined, undefined, undefined, selector), timeoutMs);
            return result.ok ? ok(result.value.items) : err(result.error.message);
        },
        deleteJob: async (namespace, name) => {
            // A Job deleted through the API orphans its pods unless told otherwise.
            const result = await within(
                api.delete({ apiVersion: 'batch/v1', kind: 'Job', metadata: { name, namespace } }, undefined, undefined, undefined, undefined, 'Background'),
                timeoutMs,
            );
            if (!result.ok) {
                return result.error.status === NOT_FOUND ? ok('not-found') : err(result.error.message);
            }
            return ok('deleted');
        },
        listPods: async (namespace, selector) => {
            const result = await within(api.list<PodObject>('v1', 'Pod', namespace, undefined, undefined, undefined, undefined, selector), timeoutMs);
            return result.ok ? ok(result.value.items.map(podInfoOf)) : err(result.error.message);
        },
        storageCapacity: async () => {
            const result = await within(
                api.list<{
                    apiVersion: string;
                    kind: string;
                    metadata: { name: string };
                    nodeTopology?: { matchLabels?: Record<string, string> };
                    capacity?: string;
                }>('storage.k8s.io/v1', 'CSIStorageCapacity'),
                timeoutMs,
            );
            if (!result.ok) {
                return err(result.error.message);
            }
            const entries = result.value.items.flatMap((item) => {
                const node = item.nodeTopology?.matchLabels?.[TOPOLVM_NODE_LABEL];
                const bytes = item.capacity === undefined ? undefined : bytesOf(item.capacity);
                return node === undefined || bytes === undefined ? [] : [[node, bytes] as const];
            });
            return ok(entries.length === 0 ? undefined : new Map(entries));
        },
        memoryFree: async (nodeName) => {
            const node = await within(
                api.read<{ apiVersion: string; kind: string; metadata: { name: string }; status?: { allocatable?: Record<string, string> } }>({
                    apiVersion: 'v1',
                    kind: 'Node',
                    metadata: { name: nodeName },
                }),
                timeoutMs,
            );
            if (!node.ok) {
                return node.error.status === NOT_FOUND ? ok(undefined) : err(node.error.message);
            }
            const allocatable = bytesOf(node.value.status?.allocatable?.['memory'] ?? '');
            if (allocatable === undefined) {
                return err(`node ${nodeName} states no allocatable memory`);
            }
            const pods = await within(
                api.list<PodObject>('v1', 'Pod', undefined, undefined, undefined, undefined, `spec.nodeName=${nodeName},status.phase!=Succeeded,status.phase!=Failed`),
                timeoutMs,
            );
            if (!pods.ok) {
                return err(pods.error.message);
            }
            const requested = pods.value.items.reduce((sum, pod) => sum + podMemoryRequest(pod), 0);
            return ok(allocatable - requested);
        },
        growVolumes: async (namespace, name, storageGb) => {
            const pvcs = await within(
                api.list<{ apiVersion: string; kind: string; metadata: { name: string }; spec?: { resources?: { requests?: Record<string, string> } } }>(
                    'v1',
                    'PersistentVolumeClaim',
                    namespace,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    `cnpg.io/cluster=${name}`,
                ),
                timeoutMs,
            );
            if (!pvcs.ok) {
                return err(pvcs.error.message);
            }
            const small = pvcs.value.items.filter((pvc) => (bytesOf(pvc.spec?.resources?.requests?.['storage'] ?? '0') ?? 0) < storageGb * 1024 ** 3);
            const results = await Promise.all(
                small.map((pvc) =>
                    within(
                        api.patch(
                            {
                                apiVersion: 'v1',
                                kind: 'PersistentVolumeClaim',
                                metadata: { name: pvc.metadata.name, namespace },
                                spec: { resources: { requests: { storage: `${storageGb}Gi` } } },
                            },
                            undefined,
                            undefined,
                            FIELD_MANAGER,
                            undefined,
                            PatchStrategy.MergePatch,
                        ),
                        timeoutMs,
                    ),
                ),
            );
            const failed = results.find((result) => !result.ok);
            return failed !== undefined && !failed.ok ? err(failed.error.message) : ok(small.map((pvc) => pvc.metadata.name));
        },
        volumeNodes: async (namespace, name) => {
            const result = await within(
                api.list<{ apiVersion: string; kind: string; metadata: { name: string; annotations?: Record<string, string> } }>(
                    'v1',
                    'PersistentVolumeClaim',
                    namespace,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    `cnpg.io/cluster=${name}`,
                ),
                timeoutMs,
            );
            return result.ok
                ? ok(result.value.items.flatMap((pvc) => pvc.metadata.annotations?.[SELECTED_NODE_ANNOTATION] ?? []))
                : err(result.error.message);
        },
        nodeSite: async (nodeName) => {
            const result = await within(
                api.read<{ apiVersion: string; kind: string; metadata: { name: string; labels?: Record<string, string> } }>({
                    apiVersion: 'v1',
                    kind: 'Node',
                    metadata: { name: nodeName },
                }),
                timeoutMs,
            );
            if (!result.ok) {
                return result.error.status === NOT_FOUND ? ok(undefined) : err(result.error.message);
            }
            return ok(result.value.metadata.labels?.[ZONE_LABEL]);
        },
        listNodes: async () => {
            type Node = {
                apiVersion: string;
                kind: string;
                metadata: { name: string; labels?: Record<string, string>; annotations?: Record<string, string>; creationTimestamp?: Date };
            };
            const result = await within(api.list<Node>('v1', 'Node'), timeoutMs);
            if (!result.ok) {
                return err(result.error.message);
            }
            return ok(result.value.items.map((node) => nodeLabels(node.metadata)));
        },
        podLog: async (namespace, pod, container, options, signal) => {
            const sink = new PassThrough();
            // The client pipes the response body into the sink without an error handler on the body: aborting it,
            // or a connection that drops, would crash the process. Its error ends the lines instead.
            sink.on('pipe', (body) => body.on('error', () => sink.end()));
            // A body still piped in after the sink was ended must not crash the process either.
            sink.on('error', () => undefined);
            const request = logs.log(namespace, pod, container, sink, {
                follow: options.follow,
                previous: options.previous,
                timestamps: true,
                ...(options.tailLines === undefined ? {} : { tailLines: options.tailLines }),
                ...(options.sinceTime === undefined ? {} : { sinceTime: options.sinceTime }),
            });
            const result = await within(request, timeoutMs);
            if (!result.ok) {
                sink.end();
                // One that answers after the timeout is closed at once.
                request.then((late) => late.abort(), () => undefined);
                return err(result.error.message);
            }
            const controller = result.value;
            // The client pipes the body into the sink without passing on its errors: ending the sink is what ends the lines.
            const stop = () => {
                controller.abort();
                sink.end();
            };
            if (signal.aborted) {
                stop();
            } else {
                signal.addEventListener('abort', stop, { once: true });
                sink.once('end', () => signal.removeEventListener('abort', stop));
            }
            return ok(createInterface({ input: sink, crlfDelay: Number.POSITIVE_INFINITY }));
        },
        remove: async (ref) => {
            const result = await within(
                api.delete({
                    apiVersion: ref.apiVersion,
                    kind: ref.kind,
                    metadata: ref.namespace === undefined ? { name: ref.name } : { name: ref.name, namespace: ref.namespace },
                }),
                timeoutMs,
            );
            return result.ok || result.error.status === NOT_FOUND ? ok(undefined) : err(result.error.message);
        },
        applySecret: async (secret) => {
            const result = await within(
                api.patch(secret, undefined, undefined, FIELD_MANAGER, true, PatchStrategy.ServerSideApply),
                timeoutMs,
            );
            if (result.ok) {
                return ok('applied');
            }
            // Applying into a missing namespace answers 404: there is nothing else it could be missing.
            return result.error.status === NOT_FOUND ? ok('no-namespace') : err(result.error.message);
        },
    };
}
