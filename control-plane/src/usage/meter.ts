/**
 * Metering (ARCHITECTURE.md, "Metering and billing"; decision 114): every
 * completed hour becomes usage events, one per Resource and unit, which the
 * billing service rates once a month.
 *
 * - `cpu_seconds`: what the Resource's pods used, from the CPU agent's
 *   per-pod totals in Prometheus (both Database instances and the Pooler,
 *   every replica of a Service, every run of a Job, short ones included).
 * - `memory_gb_hours`: the reserved size. A Database's from its row, once
 *   (its standby is in the price), for the part of the hour it existed; a
 *   Service's and Job's from Prometheus, each running pod's memory request
 *   for the minutes it ran, so replicas, rollouts and runs count and a
 *   deleted Service's last hour is not lost.
 * - `storage_gb_hours`: a Database's volume size from its row, once; a
 *   Bucket's bytes as Garage counts them.
 * - `egress_gb`: the response bytes Traefik sent for the rules of the
 *   Resource's IngressRoutes (`domain-<id>-svc-<id>`, `domain-<id>-bucket-<id>`).
 *
 * GB is 2^30 bytes throughout, as the sizes are. Each hour is metered once
 * all its figures could be read; until then it is tried again, and an
 * emitter that wrote some events already cannot bill twice (one event per
 * Resource, unit and interval start, `on conflict do nothing`).
 *
 * `eventsForHour` is pure; `meteringPass` reads, decides and writes.
 */
import { type ResourceKind, type UsageUnit, UUID } from '@openupstream/sdk';
import type pg from 'pg';
import type { ObjectStorage } from '../garage.js';
import type { PrometheusQuery, PrometheusSample } from '../prometheus.js';
import { type Result, err, ok } from '../result.js';

export const HOUR_MS = 3600_000;
const GiB = 1024 ** 3;

export interface UsageEventInput {
    readonly accountId: string;
    readonly projectId: string;
    readonly kind: ResourceKind;
    readonly resourceId: string;
    readonly unit: UsageUnit;
    readonly quantity: number;
}

export interface MeteredDatabase {
    readonly id: string;
    readonly projectId: string;
    readonly memoryMb: number;
    readonly storageGb: number;
    readonly createdAt: Date;
    readonly deletedAt: Date | undefined;
}

export interface MeteredBucket {
    readonly id: string;
    readonly projectId: string;
    readonly bytes: number;
    readonly createdAt: Date;
    readonly deletedAt: Date | undefined;
}

/** One run of a Job (a pod), from kube-state-metrics: when it started and ended, and its memory request. */
export interface JobRun {
    readonly namespace: string;
    readonly pod: string;
    readonly start: Date;
    /** Its completion, or when it was last seen (a run stopped or still running). */
    readonly end: Date;
    readonly memoryBytes: number;
}

export interface HourFigures {
    /** CPU seconds per (namespace, pod) over the hour. */
    readonly cpu: readonly PrometheusSample[];
    /** Memory requested by running Service pods, in byte-minutes, per (namespace, pod). */
    readonly memory: readonly PrometheusSample[];
    /** Job runs that overlapped the hour: their memory for exactly the time they ran (a run lasts seconds, too short to sample). */
    readonly jobRuns: readonly JobRun[];
    /** Response bytes per Traefik service over the hour. */
    readonly egress: readonly PrometheusSample[];
    readonly databases: readonly MeteredDatabase[];
    readonly buckets: readonly MeteredBucket[];
    /** Each Project's Account, deleted Projects included. */
    readonly accountOf: ReadonlyMap<string, string>;
}

const UUID_PATTERN = UUID.source.replace(/^\^|\$$/g, '');
const POD = new RegExp(`^(db|svc|job)-(${UUID_PATTERN})(-|$)`);
const NAMESPACE = new RegExp(`^project-(${UUID_PATTERN})$`);
/**
 * Traefik's name for one rule's service: `<namespace>-<IngressRoute>-<hash
 * of the rule>@kubernetescrd`, the IngressRoute being `domain-<id>-bucket-<id>`
 * or `domain-<id>-svc-<id>` (one per Domain and Resource, decision 114).
 */
const TRAEFIK_SERVICE = new RegExp(`^project-(${UUID_PATTERN})-domain-${UUID_PATTERN}-(svc|bucket)-(${UUID_PATTERN})-[0-9a-f]+@kubernetescrd$`);

const KIND_OF_PREFIX: Readonly<Record<string, ResourceKind>> = { db: 'database', svc: 'service', job: 'job', bucket: 'bucket' };

/** The share of the hour [start, start + 1 h) a Resource existed. */
export const shareOfHour = (start: Date, createdAt: Date, deletedAt: Date | undefined): number => {
    const end = start.getTime() + HOUR_MS;
    const from = Math.max(start.getTime(), createdAt.getTime());
    const to = Math.min(end, deletedAt?.getTime() ?? end);
    return Math.max(0, to - from) / HOUR_MS;
};

const round = (quantity: number): number => Math.round(quantity * 1e6) / 1e6;

export function eventsForHour(start: Date, figures: HourFigures): { readonly events: UsageEventInput[]; readonly unattributed: number } {
    const sums = new Map<string, { projectId: string; kind: ResourceKind; resourceId: string; unit: UsageUnit; quantity: number }>();
    let unattributed = 0;
    const add = (projectId: string, kind: ResourceKind, resourceId: string, unit: UsageUnit, quantity: number) => {
        if (!(quantity > 0) || !Number.isFinite(quantity)) {
            return;
        }
        const key = `${resourceId} ${unit}`;
        const seen = sums.get(key);
        sums.set(key, { projectId, kind, resourceId, unit, quantity: (seen?.quantity ?? 0) + quantity });
    };
    const fromPods = (samples: readonly PrometheusSample[], unit: UsageUnit, scale: number) => {
        for (const sample of samples) {
            const projectId = NAMESPACE.exec(sample.labels['namespace'] ?? '')?.[1];
            const pod = POD.exec(sample.labels['pod'] ?? '');
            const kind = KIND_OF_PREFIX[pod?.[1] ?? ''];
            if (projectId === undefined || pod?.[2] === undefined || kind === undefined) {
                unattributed += 1;
                continue;
            }
            add(projectId, kind, pod[2], unit, sample.value * scale);
        }
    };
    fromPods(figures.cpu, 'cpu_seconds', 1);
    // Byte-minutes to GB-hours.
    fromPods(figures.memory, 'memory_gb_hours', 1 / 60 / GiB);
    for (const run of figures.jobRuns) {
        const share = shareOfHour(start, run.start, run.end);
        fromPods([{ labels: { namespace: run.namespace, pod: run.pod }, value: run.memoryBytes * share }], 'memory_gb_hours', 1 / GiB);
    }
    for (const sample of figures.egress) {
        const service = TRAEFIK_SERVICE.exec(sample.labels['service'] ?? '');
        const kind = KIND_OF_PREFIX[service?.[2] ?? ''];
        if (service?.[1] === undefined || service[3] === undefined || kind === undefined) {
            unattributed += 1;
            continue;
        }
        add(service[1], kind, service[3], 'egress_gb', sample.value / GiB);
    }
    for (const database of figures.databases) {
        const share = shareOfHour(start, database.createdAt, database.deletedAt);
        add(database.projectId, 'database', database.id, 'memory_gb_hours', (database.memoryMb / 1024) * share);
        add(database.projectId, 'database', database.id, 'storage_gb_hours', database.storageGb * share);
    }
    for (const bucket of figures.buckets) {
        add(bucket.projectId, 'bucket', bucket.id, 'storage_gb_hours', (bucket.bytes / GiB) * shareOfHour(start, bucket.createdAt, bucket.deletedAt));
    }
    const events = [...sums.values()].flatMap((sum): UsageEventInput[] => {
        const accountId = figures.accountOf.get(sum.projectId);
        if (accountId === undefined) {
            unattributed += 1;
            return [];
        }
        return [{ accountId, projectId: sum.projectId, kind: sum.kind, resourceId: sum.resourceId, unit: sum.unit, quantity: round(sum.quantity) }];
    });
    return { events: events.filter((event) => event.quantity > 0), unattributed };
}

const PROJECTS = 'namespace=~"project-.*"';
const AGENT_CPU = `openupstream_pod_cpu_usage_seconds_total{${PROJECTS}, pod=~"(db|svc|job)-.*"}`;
/**
 * Every pod's CPU seconds over the hour ending at the query time, from the
 * CPU agent's totals (decision 115): the kernel's count for the pod's whole
 * life, gVisor's sandbox included, kept after the pod ended. A pod's hour is
 * its total at the end of the hour less its total at the end of the hour
 * before (none for a pod that started in this hour), per uid, so a restarted
 * pod of the same name starts from zero. Absolute totals, not increase():
 * nothing is lost before a first scrape or after a last one.
 */
export const CPU_QUERY = `sum by (namespace, pod) (max by (namespace, pod, uid) (max_over_time(${AGENT_CPU}[1h])) - (max by (namespace, pod, uid) (max_over_time(${AGENT_CPU}[1h] offset 1h)) or max by (namespace, pod, uid) (max_over_time(${AGENT_CPU}[1h])) * 0))`;
/** Byte-minutes of memory requested by Service pods while Running, minute by minute over the hour. */
export const MEMORY_QUERY = `sum by (namespace, pod) (sum_over_time((sum by (namespace, pod) (kube_pod_container_resource_requests{${PROJECTS}, resource="memory", pod=~"svc-.*"}) * on (namespace, pod) (max by (namespace, pod) (kube_pod_status_phase{${PROJECTS}, phase="Running"}) == 1))[1h:1m]))`;
const JOB_PODS = `${PROJECTS}, pod=~"job-.*"`;
/** Job runs seen in the hour: start (epoch seconds), completion, last seen, memory request. */
export const JOB_START_QUERY = `max by (namespace, pod) (max_over_time(kube_pod_start_time{${JOB_PODS}}[1h]))`;
export const JOB_COMPLETION_QUERY = `max by (namespace, pod) (max_over_time(kube_pod_completion_time{${JOB_PODS}}[1h]))`;
export const JOB_LAST_SEEN_QUERY = `max by (namespace, pod) (max_over_time(timestamp(kube_pod_start_time{${JOB_PODS}})[1h:30s]))`;
export const JOB_MEMORY_QUERY = `sum by (namespace, pod) (max_over_time(kube_pod_container_resource_requests{${JOB_PODS}, resource="memory"}[1h]))`;

/** Job runs from the four queries' answers; a run needs at least a start and a memory request. */
export function jobRunsOf(
    starts: readonly PrometheusSample[],
    completions: readonly PrometheusSample[],
    lastSeen: readonly PrometheusSample[],
    memory: readonly PrometheusSample[],
): JobRun[] {
    const key = (sample: PrometheusSample) => `${sample.labels['namespace'] ?? ''}/${sample.labels['pod'] ?? ''}`;
    const byKey = (samples: readonly PrometheusSample[]) => new Map(samples.map((sample) => [key(sample), sample.value]));
    const [completion, seen, bytes] = [byKey(completions), byKey(lastSeen), byKey(memory)];
    return starts.flatMap((sample): JobRun[] => {
        const end = completion.get(key(sample)) ?? seen.get(key(sample));
        const memoryBytes = bytes.get(key(sample));
        return end === undefined || memoryBytes === undefined
            ? []
            : [{ namespace: sample.labels['namespace'] ?? '', pod: sample.labels['pod'] ?? '', start: new Date(sample.value * 1000), end: new Date(end * 1000), memoryBytes }];
    });
}
/** Whether Prometheus scraped anything at the hour's end: without that, empty answers mean no data, not no usage. */
export const COVERAGE_QUERY = 'count(up == 1)';
/** Response bytes per rule's service over the hour. */
export const EGRESS_QUERY = `sum by (service) (increase(traefik_service_responses_bytes_total{service=~"project-.*@kubernetescrd"}[1h]))`;

export interface MeteringDeps {
    readonly pool: pg.Pool;
    readonly prometheus: PrometheusQuery;
    readonly storage: ObjectStorage;
    readonly log: (entry: Record<string, unknown>) => void;
    readonly now?: () => Date;
}

/** How long after an hour ends its last scrapes are surely in Prometheus. */
export const SETTLE_MS = 5 * 60_000;
/** Prometheus keeps 15 days; an hour older than this cannot be metered any more. */
export const CATCH_UP_MS = 14 * 24 * HOUR_MS;
const HOURS_PER_PASS = 24;
/**
 * How long an hour Prometheus has no samples for waits (it may be catching
 * up after a restart) before it is recorded with the rows' figures only,
 * so it cannot hold back every later hour.
 */
export const NO_DATA_WAIT_MS = 2 * HOUR_MS;

/** The hours to meter now, oldest first: after the last metered one (or the last full hour), up to HOURS_PER_PASS. */
export function hoursToMeter(lastMetered: Date | undefined, now: Date): Date[] {
    const lastComplete = Math.floor((now.getTime() - SETTLE_MS) / HOUR_MS) * HOUR_MS - HOUR_MS;
    const earliest = Math.ceil((now.getTime() - CATCH_UP_MS) / HOUR_MS) * HOUR_MS;
    const first = Math.max(lastMetered === undefined ? lastComplete : lastMetered.getTime() + HOUR_MS, earliest);
    const hours: Date[] = [];
    for (let hour = first; hour <= lastComplete && hours.length < HOURS_PER_PASS; hour += HOUR_MS) {
        hours.push(new Date(hour));
    }
    return hours;
}

export async function meteringPass(deps: MeteringDeps): Promise<void> {
    const now = deps.now?.() ?? new Date();
    const { rows } = await deps.pool.query<{ hour: Date | null }>('select max(hour) as hour from metered_hours');
    const hours = hoursToMeter(rows[0]?.hour ?? undefined, now);
    const first = hours[0];
    if (first === undefined) {
        return;
    }
    const sizes = await bucketSizes(deps, first);
    if (!sizes.ok) {
        deps.log({ msg: 'metering: hour not metered yet', hour: first.toISOString(), error: sizes.error });
        return;
    }
    for (const hour of hours) {
        const metered = await meterHour(deps, hour, now, sizes.value);
        if (!metered.ok) {
            deps.log({ msg: 'metering: hour not metered yet', hour: hour.toISOString(), error: metered.error });
            return;
        }
        deps.log({ msg: 'metering: hour metered', hour: hour.toISOString(), events: metered.value.events, unattributed: metered.value.unattributed });
    }
}

/**
 * The bytes of every Bucket that lived since `since`, by Garage bucket id,
 * read once per pass and in parallel: Garage has no history, so every hour
 * gets the size of now. A Bucket Garage cannot answer for (a deleted one
 * whose objects are gone, or one out of step) counts as empty and is logged;
 * only Garage answering for none at all holds the hour back.
 */
async function bucketSizes(deps: MeteringDeps, since: Date): Promise<Result<Map<string, number>, string>> {
    const { rows } = await deps.pool.query<{ garage_bucket_id: string; deleted_at: Date | null }>(
        'select garage_bucket_id, deleted_at from buckets where deleted_at is null or deleted_at > $1',
        [since],
    );
    const answers = await Promise.all(rows.map(async (row) => ({ row, bytes: await deps.storage.bucketBytes(row.garage_bucket_id) })));
    const live = answers.filter(({ row }) => row.deleted_at === null);
    if (live.length > 0 && live.every(({ bytes }) => !bytes.ok)) {
        const first = live[0]?.bytes;
        return err(`Garage: ${first !== undefined && !first.ok ? first.error : 'no answer'}`);
    }
    const unreadable = live.filter(({ bytes }) => !bytes.ok).map(({ row }) => row.garage_bucket_id);
    if (unreadable.length > 0) {
        deps.log({ msg: 'metering: Buckets Garage cannot size, counted as empty', garageBuckets: unreadable });
    }
    return ok(new Map(answers.flatMap(({ row, bytes }): [string, number][] => (bytes.ok ? [[row.garage_bucket_id, bytes.value]] : []))));
}

async function meterHour(
    deps: MeteringDeps,
    start: Date,
    now: Date,
    sizes: ReadonlyMap<string, number>,
): Promise<Result<{ events: number; unattributed: number }, string>> {
    const end = new Date(start.getTime() + HOUR_MS);
    const answers = await Promise.all(
        [CPU_QUERY, MEMORY_QUERY, EGRESS_QUERY, COVERAGE_QUERY, JOB_START_QUERY, JOB_COMPLETION_QUERY, JOB_LAST_SEEN_QUERY, JOB_MEMORY_QUERY].map((query) =>
            deps.prometheus(query, end),
        ),
    );
    const [cpu, memory, egress, coverage, jobStarts, jobCompletions, jobLastSeen, jobMemory] = answers;
    const failed = answers.find((result) => !result.ok);
    if (failed !== undefined && !failed.ok) {
        return err(`Prometheus: ${failed.error}`);
    }
    if (coverage?.ok && coverage.value.length === 0) {
        if (now.getTime() - end.getTime() < NO_DATA_WAIT_MS) {
            return err('Prometheus has no samples at the end of the hour yet');
        }
        deps.log({ msg: 'metering: no Prometheus data for the hour; only Databases and Buckets metered', hour: start.toISOString() });
    }
    const databases = await deps.pool.query<{ id: string; project_id: string; memory_mb: number; storage_gb: number; created_at: Date; deleted_at: Date | null }>(
        `select id, project_id, memory_mb, storage_gb, created_at, deleted_at from databases
         where created_at < $2 and (deleted_at is null or deleted_at > $1)`,
        [start, end],
    );
    const bucketRows = await deps.pool.query<{ id: string; project_id: string; garage_bucket_id: string; created_at: Date; deleted_at: Date | null }>(
        `select id, project_id, garage_bucket_id, created_at, deleted_at from buckets
         where created_at < $2 and (deleted_at is null or deleted_at > $1)`,
        [start, end],
    );
    const buckets: MeteredBucket[] = bucketRows.rows.map((row) => ({
        id: row.id,
        projectId: row.project_id,
        bytes: sizes.get(row.garage_bucket_id) ?? 0,
        createdAt: row.created_at,
        deletedAt: row.deleted_at ?? undefined,
    }));
    const projects = await deps.pool.query<{ id: string; account_id: string }>('select id, account_id from projects');
    const { events, unattributed } = eventsForHour(start, {
        cpu: cpu?.ok ? cpu.value : [],
        memory: memory?.ok ? memory.value : [],
        egress: egress?.ok ? egress.value : [],
        jobRuns: jobRunsOf(
            jobStarts?.ok ? jobStarts.value : [],
            jobCompletions?.ok ? jobCompletions.value : [],
            jobLastSeen?.ok ? jobLastSeen.value : [],
            jobMemory?.ok ? jobMemory.value : [],
        ),
        databases: databases.rows.map((row) => ({
            id: row.id,
            projectId: row.project_id,
            memoryMb: row.memory_mb,
            storageGb: row.storage_gb,
            createdAt: row.created_at,
            deletedAt: row.deleted_at ?? undefined,
        })),
        buckets,
        accountOf: new Map(projects.rows.map((row) => [row.id, row.account_id])),
    });
    // One statement, so the events and the hour land together or not at all.
    await deps.pool.query(
        `with events as (
             insert into usage_events (account_id, project_id, resource_kind, resource_id, unit, quantity, interval_start, interval_end)
             select e.account_id, e.project_id, e.resource_kind, e.resource_id, e.unit, e.quantity, $2, $3
             from jsonb_to_recordset($1::jsonb) as e(account_id uuid, project_id uuid, resource_kind text, resource_id uuid, unit text, quantity numeric)
             on conflict (resource_id, unit, interval_start) do nothing
         )
         insert into metered_hours (hour) values ($2) on conflict do nothing`,
        [
            JSON.stringify(
                events.map((event) => ({
                    account_id: event.accountId,
                    project_id: event.projectId,
                    resource_kind: event.kind,
                    resource_id: event.resourceId,
                    unit: event.unit,
                    quantity: event.quantity,
                })),
            ),
            start,
            end,
        ],
    );
    return ok({ events: events.length, unattributed });
}
