/**
 * The bandwidth agent (ARCHITECTURE.md, "Project isolation"; decision 122):
 * one per compute node (operators/deploy/bandwidth-agent.yaml), on the
 * node's network. k3s's CNI limits each customer pod to 300 Mbit/s each way
 * when it starts, from the pod's annotations, and never looks again. Every
 * second this agent
 *
 * - shrinks a new pod's burst, which the CNI sets to 512 MB, to a tenth of
 *   a second of its limit, so the limit holds from the start, and
 * - while the node's uplink is above 80% of its speed, lowers every
 *   customer pod's limit to the fair share (shares.ts), and raises it again
 *   when there is room.
 *
 * It changes the pods' token buckets with `tc`, which needs root with
 * NET_ADMIN in the node's network namespace; it does not talk to the
 * Kubernetes API and listens on no port. A pod started while the agent is
 * down has the CNI's limit and burst; a limit the agent lowered stays until
 * it is back. On SIGTERM it sets every pod to the maximum.
 *
 * Environment:
 * - UPLINK_INTERFACE: default the interface of the default route
 * - UPLINK_MBIT: the uplink's speed; default what the interface reports
 *   (`/sys/class/net/<interface>/speed`, read on every pass). While
 *   neither gives one nothing is lowered, only bursts are set.
 * - INTERVAL_MS: default 1000
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { type Result, err, ok } from '../result.js';
import { type Direction, MAX_BITS, type Snapshot, bucketsOf, defaultRouteDev, directionsOf, plan, shapersOf, tcArgs } from './shares.js';

const log = (entry: Record<string, unknown>): void => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

const run = (command: string, args: readonly string[]): Promise<Result<string, string>> =>
    new Promise((resolve) =>
        execFile(command, [...args], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
            resolve(error === null ? ok(stdout) : err(stderr.trim() || error.message)),
        ),
    );

const numberIn = (path: string): Promise<number | undefined> =>
    readFile(path, 'utf8').then(
        (text) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined),
        () => undefined,
    );

const set = (name: string): string | undefined => {
    const value = process.env[name];
    return value === undefined || value === '' ? undefined : value;
};

const intervalMs = Number(set('INTERVAL_MS') ?? 1000);
if (!Number.isFinite(intervalMs) || intervalMs < 100) {
    log({ msg: 'INTERVAL_MS must be a number of milliseconds, at least 100' });
    process.exit(1);
}
const configuredMbit = set('UPLINK_MBIT') === undefined ? undefined : Number(set('UPLINK_MBIT'));
if (configuredMbit !== undefined && !(Number.isFinite(configuredMbit) && configuredMbit > 0)) {
    log({ msg: 'UPLINK_MBIT must be a number of Mbit/s above 0' });
    process.exit(1);
}

const defaultRoute = await run('ip', ['-j', 'route', 'show', 'default']);
const uplink = set('UPLINK_INTERFACE') ?? (defaultRoute.ok ? defaultRouteDev(defaultRoute.value) : undefined);
if (uplink === undefined) {
    log({ msg: 'no default route and no UPLINK_INTERFACE: cannot tell the uplink' });
    process.exit(1);
}

/**
 * The uplink's speed in bits per second, or undefined: a virtual interface
 * reports none (-1), and one whose link is down cannot be read. Read on
 * every pass, since a link comes up after the node and may renegotiate.
 */
async function uplinkCapacity(): Promise<number | undefined> {
    const mbit = configuredMbit ?? (await numberIn(`/sys/class/net/${uplink}/speed`));
    return mbit !== undefined && mbit > 0 ? mbit * 1_000_000 : undefined;
}

/** Each device's direction, looked up once: a device's kind never changes. */
let directions: ReadonlyMap<string, Direction> = new Map();

/** The pods' token buckets and the uplink's counters now; undefined when the node cannot be read. */
async function snapshot(): Promise<Snapshot | undefined> {
    const [qdiscs, rx, tx] = await Promise.all([
        run('tc', ['-s', '-j', 'qdisc', 'show']),
        numberIn(`/sys/class/net/${uplink}/statistics/rx_bytes`),
        numberIn(`/sys/class/net/${uplink}/statistics/tx_bytes`),
    ]);
    if (!qdiscs.ok || rx === undefined || tx === undefined) {
        log({ msg: 'cannot read the node', error: !qdiscs.ok ? qdiscs.error : `no counters for ${uplink}` });
        return undefined;
    }
    const buckets = bucketsOf(qdiscs.value);
    if (buckets.some((bucket) => !directions.has(bucket.dev))) {
        // A new pod's devices (or a bucket that is not a pod's, which stays unknown and is asked for again).
        const links = await run('ip', ['-j', '-d', 'link', 'show']);
        if (!links.ok) {
            log({ msg: 'cannot read the node', error: links.error });
            return undefined;
        }
        directions = directionsOf(links.value);
    }
    // performance.now() never steps, as the time of day does when it is corrected.
    return { at: performance.now() / 1000, shapers: shapersOf(buckets, directions), uplinkBytes: { ingress: rx, egress: tx } };
}

/** Devices whose bucket could not be set, to log each once and not on every pass. */
let failing: ReadonlySet<string> = new Set();

/** Sets buckets to their limit, one after another; a pod that ended meanwhile fails and is left. */
async function apply(changes: readonly { readonly dev: string; readonly limitBits: number }[], present: ReadonlySet<string>): Promise<void> {
    const failed = new Set([...failing].filter((dev) => present.has(dev)));
    for (const { dev, limitBits } of changes) {
        const changed = await run('tc', tcArgs(dev, limitBits));
        if (changed.ok) {
            failed.delete(dev);
        } else if (!failed.has(dev)) {
            failed.add(dev);
            log({ msg: 'cannot set a limit; not logged again for this device', dev, error: changed.error });
        }
    }
    failing = failed;
}

let last: Snapshot | undefined;
/** The limit last logged per direction, to log changes only. */
let logged: Readonly<Record<Direction, number>> = { ingress: MAX_BITS, egress: MAX_BITS };
let capacityLogged: number | undefined | null = null;

async function pass(): Promise<void> {
    const [now, capacityBits] = await Promise.all([snapshot(), uplinkCapacity()]);
    if (capacityBits !== capacityLogged) {
        log(capacityBits === undefined ? { msg: 'uplink speed unknown: limits are not lowered (set UPLINK_MBIT)', uplink } : { msg: 'uplink speed', uplink, mbit: capacityBits / 1e6 });
        capacityLogged = capacityBits;
    }
    if (now === undefined) {
        return;
    }
    const { limits, changes } = plan(last, now, capacityBits);
    last = now;
    if (limits !== undefined) {
        for (const direction of ['ingress', 'egress'] as const) {
            const limit = limits[direction];
            if (Math.abs(limit - logged[direction]) >= logged[direction] * 0.05 || (limit === MAX_BITS && logged[direction] !== MAX_BITS)) {
                log({ msg: 'limit', direction, mbit: limit / 1e6, pods: now.shapers.filter((shaper) => shaper.direction === direction).length });
                logged = { ...logged, [direction]: limit };
            }
        }
    }
    await apply(changes, new Set(now.shapers.map((shaper) => shaper.dev)));
}

let stopping = false;
process.once('SIGTERM', () => {
    stopping = true;
});

log({ msg: 'bandwidth agent started', uplink, intervalMs });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
while (!stopping) {
    await pass();
    await sleep(intervalMs);
}
// Leave no pod below the maximum while nothing watches the uplink.
const final = await snapshot();
const shapers = final?.shapers ?? [];
await apply(
    shapers.filter((shaper) => shaper.rateBits !== MAX_BITS).map((shaper) => ({ dev: shaper.dev, limitBits: MAX_BITS })),
    new Set(shapers.map((shaper) => shaper.dev)),
);
log({ msg: 'bandwidth agent stopped; limits back at the maximum' });
