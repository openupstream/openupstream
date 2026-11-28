/**
 * Holds a Database's client connections while CloudNativePG restarts its
 * primary (ARCHITECTURE.md, decision 152, step 2): a shrink, a new image and
 * any other change Kubernetes cannot make to a running pod.
 *
 * CloudNativePG restarts the standby first and then the primary in place
 * (PRIMARY_RESTART), which it announces in the Cluster's phase. The guard
 * then pauses the Database's Pooler: PgBouncer lets running transactions
 * finish, closes its connections to Postgres and queues what the clients
 * send next, so the primary's smart shutdown, which waits for exactly those
 * connections, ends at once. When the primary serves again the guard
 * resumes the Pooler, and the queued queries run. Clients see a stall, not
 * an error, as long as they wait that long.
 *
 * Reacting late costs nothing but time: until the Pooler is paused the old
 * primary keeps serving, for up to its smart shutdown timeout. Resuming
 * late is the stall itself, so a paused Database is looked at often.
 *
 * `step` is pure and decides; `guardTick` reads Kubernetes and applies.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { Kube, KubeObject } from '../kube.js';
import { LABELS, MANAGED_BY } from '../kubernetes.js';
import type { PassLog } from './loop.js';

/** CloudNativePG's phases while it restarts a primary without a switchover: with a new pod, or in its pod. */
export const RESTART_PHASES: readonly string[] = [
    'Primary instance is being restarted without a switchover',
    'Primary instance is being restarted in-place',
];

/**
 * A Pooler is resumed after this long whatever the primary does: clients
 * are better off with errors than waiting on a restart that hangs.
 * PgBouncer gives up on a queued query after 120 s by itself.
 */
export const MAX_PAUSE_MS = 60_000;

/** The guard's own field manager: the reconcile pass applies the Pooler without `paused` and so leaves it alone. */
export const GUARD_FIELD_MANAGER = 'openupstream-restart-guard';

/** On a Pooler the guard paused, so that one left paused by a guard that died is found and resumed. */
export const PAUSED_BY_ANNOTATION = 'openupstream.io/paused-by';
const PAUSED_BY = 'restart-guard';

/** The pod of a Cluster's current primary. */
export interface PrimaryPod {
    readonly uid: string;
    /** It has the primary's role label, is Ready and is not being deleted: the Cluster's read-write Service leads to it. */
    readonly serving: boolean;
}

export type GuardState =
    | { readonly kind: 'idle' }
    | {
          readonly kind: 'paused';
          /** The primary's pod when the Pooler was paused; undefined when there was none. */
          readonly oldUid: string | undefined;
          /** The primary has been seen not serving since: a restart in its pod keeps the pod. */
          readonly sawDown: boolean;
          readonly sinceMs: number;
      }
    /** Resumed, while CloudNativePG still shows the restart's phase: not to be paused again. */
    | { readonly kind: 'done' };

export type GuardAction = 'pause' | 'resume' | 'none';

export const IDLE: GuardState = { kind: 'idle' };

/** What to do for one Cluster, given whether its phase says the primary is being restarted and its primary's pod now. */
export function step(
    state: GuardState,
    restarting: boolean,
    pod: PrimaryPod | undefined,
    nowMs: number,
): { readonly state: GuardState; readonly action: GuardAction } {
    const down = pod === undefined || !pod.serving;
    if (state.kind === 'idle') {
        return restarting
            ? { state: { kind: 'paused', oldUid: pod?.uid, sawDown: down, sinceMs: nowMs }, action: 'pause' }
            : { state, action: 'none' };
    }
    if (state.kind === 'done') {
        return { state: restarting ? state : IDLE, action: 'none' };
    }
    const sawDown = state.sawDown || down;
    const restarted = !down && (pod.uid !== state.oldUid || sawDown);
    const calledOff = !down && !restarting;
    const expired = nowMs - state.sinceMs > MAX_PAUSE_MS;
    return restarted || calledOff || expired ? { state: { kind: 'done' }, action: 'resume' } : { state: { ...state, sawDown }, action: 'none' };
}

/** The part of a Pooler the guard owns. */
export const pausePatch = (namespace: string, pooler: string, paused: boolean): KubeObject => ({
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Pooler',
    metadata: { name: pooler, namespace, ...(paused ? { annotations: { [PAUSED_BY_ANNOTATION]: PAUSED_BY } } : {}) },
    spec: { pgbouncer: { paused } },
});

interface ClusterFields {
    readonly status?: { readonly phase?: string; readonly currentPrimary?: string };
}

interface PodFields {
    readonly metadata: { readonly uid?: string; readonly labels?: Readonly<Record<string, string>>; readonly deletionTimestamp?: unknown };
    readonly status?: { readonly conditions?: readonly { readonly type: string; readonly status: string }[] };
}

/** CloudNativePG's label on an instance pod: `primary` on the one the read-write Service selects. */
const ROLE_LABEL = 'cnpg.io/instanceRole';

export const primaryPodOf = (pod: KubeObject | undefined): PrimaryPod | undefined => {
    const fields = pod as PodFields | undefined;
    const uid = fields?.metadata.uid;
    if (fields === undefined || uid === undefined) {
        return undefined;
    }
    const ready = (fields.status?.conditions ?? []).some((condition) => condition.type === 'Ready' && condition.status === 'True');
    return { uid, serving: ready && fields.metadata.labels?.[ROLE_LABEL] === 'primary' && fields.metadata.deletionTimestamp == null };
};

/** The Pooler of a Cluster, by the names the manifests give them (`poolerName`). */
const poolerOf = (cluster: string): string => `${cluster}-pooler`;

const OURS = `${LABELS.managedBy}=${MANAGED_BY}`;

export type GuardStates = Map<string, GuardState>;

/**
 * One look at every Cluster: pauses and resumes Poolers, keeps each
 * Cluster's state in `states`, and returns what it did or could not do.
 * A failed read or write changes no state, so the next tick tries again.
 */
export async function guardTick(kube: Kube, states: GuardStates, nowMs: number): Promise<PassLog[]> {
    const clusters = await kube.listObjects('postgresql.cnpg.io/v1', 'Cluster', OURS);
    if (!clusters.ok) {
        return [{ msg: 'restart guard: cannot list the Clusters', error: clusters.error }];
    }
    const seen = new Set<string>();
    const logs: PassLog[] = [];
    for (const cluster of clusters.value) {
        const namespace = cluster.metadata.namespace ?? '';
        const name = cluster.metadata.name;
        const key = `${namespace}/${name}`;
        seen.add(key);
        const status = (cluster as ClusterFields).status;
        const state = states.get(key) ?? IDLE;
        const restarting = RESTART_PHASES.includes(status?.phase ?? '');
        if (state.kind !== 'paused' && !restarting) {
            states.delete(key);
            continue;
        }
        if (state.kind === 'done') {
            continue;
        }
        const pod =
            status?.currentPrimary === undefined
                ? undefined
                : await kube.read({ apiVersion: 'v1', kind: 'Pod', namespace, name: status.currentPrimary });
        if (pod !== undefined && !pod.ok) {
            logs.push({ msg: "restart guard: cannot read the primary's pod", cluster: key, error: pod.error });
            continue;
        }
        const next = step(state, restarting, primaryPodOf(pod?.value), nowMs);
        if (next.action !== 'none') {
            const paused = next.action === 'pause';
            const applied = await kube.apply(pausePatch(namespace, poolerOf(name), paused), { dryRun: false, fieldManager: GUARD_FIELD_MANAGER });
            if (!applied.ok) {
                logs.push({ msg: `restart guard: cannot ${next.action} the Pooler`, cluster: key, error: applied.error });
                continue;
            }
            const heldMs = state.kind === 'paused' ? nowMs - state.sinceMs : undefined;
            logs.push({
                msg: paused ? 'restart guard: Pooler paused, the primary is being restarted' : 'restart guard: Pooler resumed',
                cluster: key,
                ...(heldMs === undefined ? {} : { heldMs, ...(heldMs > MAX_PAUSE_MS ? { reason: 'the primary did not come back in time' } : {}) }),
            });
        }
        states.set(key, next.state);
    }
    for (const key of [...states.keys()].filter((known) => !seen.has(known))) {
        states.delete(key);
    }
    return logs;
}

/**
 * Resumes every Pooler a guard paused and did not resume: the one before
 * this process, which died in between. Its Database's restart may still be
 * under way, and then goes on as it would without a guard.
 */
export async function resumeLeftovers(kube: Kube): Promise<PassLog[]> {
    const poolers = await kube.listObjects('postgresql.cnpg.io/v1', 'Pooler', OURS);
    if (!poolers.ok) {
        return [{ msg: 'restart guard: cannot list the Poolers', error: poolers.error }];
    }
    const left = poolers.value.filter(
        (pooler) =>
            pooler.metadata.annotations?.[PAUSED_BY_ANNOTATION] === PAUSED_BY &&
            (pooler['spec'] as { pgbouncer?: { paused?: boolean } } | undefined)?.pgbouncer?.paused === true,
    );
    const logs: PassLog[] = [];
    for (const pooler of left) {
        const namespace = pooler.metadata.namespace ?? '';
        const applied = await kube.apply(pausePatch(namespace, pooler.metadata.name, false), { dryRun: false, fieldManager: GUARD_FIELD_MANAGER });
        logs.push(
            applied.ok
                ? { msg: 'restart guard: resumed a Pooler left paused', pooler: `${namespace}/${pooler.metadata.name}` }
                : { msg: 'restart guard: cannot resume a Pooler left paused', pooler: `${namespace}/${pooler.metadata.name}`, error: applied.error },
        );
    }
    return logs;
}

/** How often the Clusters are looked at: a restart is noticed well within the primary's smart shutdown timeout. */
export const WATCH_INTERVAL_MS = 3_000;
/** And while a Pooler is paused, when every wait is a client's wait. */
export const PAUSED_INTERVAL_MS = 250;

/** Runs the guard until `signal` aborts. */
export async function runGuard(kube: Kube, log: (entry: PassLog) => void, signal: AbortSignal, now: () => number = Date.now): Promise<void> {
    (await resumeLeftovers(kube)).forEach(log);
    const states: GuardStates = new Map();
    while (!signal.aborted) {
        (await guardTick(kube, states, now())).forEach(log);
        const paused = [...states.values()].some((state) => state.kind === 'paused');
        await sleep(paused ? PAUSED_INTERVAL_MS : WATCH_INTERVAL_MS, undefined, { signal }).catch(() => undefined);
    }
}
