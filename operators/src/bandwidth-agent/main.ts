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
 *   (`/sys/class/net/<interface>/speed`). Without either nothing is
 *   lowered, only bursts are set.
 * - INTERVAL_MS: default 1000
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { type Result, err, ok } from '../result.js';
import { type Direction, MAX_BITS, type Shaper, bitsPerSecond, directionsOf, limitFor, needsChange, shapersOf, tcArgs } from './shares.js';

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

const intervalMs = Number(process.env['INTERVAL_MS'] ?? 1000);
if (!Number.isFinite(intervalMs) || intervalMs < 100) {
    log({ msg: 'INTERVAL_MS must be a number of milliseconds, at least 100' });
    process.exit(1);
}

/** The interface the node reaches the internet through. */
async function uplinkInterface(): Promise<string | undefined> {
    const configured = process.env['UPLINK_INTERFACE'];
    if (configured !== undefined && configured !== '') {
        return configured;
    }
    const routes = await run('ip', ['-j', 'route', 'show', 'default']);
    const first: unknown = routes.ok && routes.value.trim() !== '' ? (JSON.parse(routes.value) as unknown[])[0] : undefined;
    const dev = typeof first === 'object' && first !== null ? (first as { dev?: unknown }).dev : undefined;
    return typeof dev === 'string' ? dev : undefined;
}

/** The uplink's speed in bits per second, or undefined: a virtual interface reports none (-1). */
async function uplinkCapacity(dev: string): Promise<number | undefined> {
    const configured = process.env['UPLINK_MBIT'];
    const mbit = configured !== undefined && configured !== '' ? Number(configured) : await numberIn(`/sys/class/net/${dev}/speed`);
    return mbit !== undefined && Number.isFinite(mbit) && mbit > 0 ? mbit * 1_000_000 : undefined;
}

const uplink = await uplinkInterface();
if (uplink === undefined) {
    log({ msg: 'no default route and no UPLINK_INTERFACE: cannot tell the uplink' });
    process.exit(1);
}
const capacityBits = await uplinkCapacity(uplink);
log({
    msg: capacityBits === undefined ? 'bandwidth agent started; uplink speed unknown, limits are never lowered (set UPLINK_MBIT)' : 'bandwidth agent started',
    uplink,
    uplinkMbit: capacityBits === undefined ? null : capacityBits / 1e6,
    intervalMs,
});

const DIRECTIONS: readonly Direction[] = ['ingress', 'egress'];

interface Snapshot {
    readonly at: number;
    readonly shapers: readonly Shaper[];
    readonly uplinkBytes: Readonly<Record<Direction, number>>;
}

/** The pods' token buckets and the uplink's counters now; undefined when the node cannot be read. */
async function snapshot(): Promise<Snapshot | undefined> {
    const [links, qdiscs, rx, tx] = await Promise.all([
        run('ip', ['-j', '-d', 'link', 'show']),
        run('tc', ['-s', '-j', 'qdisc', 'show']),
        numberIn(`/sys/class/net/${uplink}/statistics/rx_bytes`),
        numberIn(`/sys/class/net/${uplink}/statistics/tx_bytes`),
    ]);
    if (!links.ok || !qdiscs.ok || rx === undefined || tx === undefined) {
        log({ msg: 'cannot read the node', error: !links.ok ? links.error : !qdiscs.ok ? qdiscs.error : `no counters for ${uplink}` });
        return undefined;
    }
    // What the pods receive arrives on the uplink; what they send leaves on it.
    return { at: Date.now(), shapers: shapersOf(qdiscs.value, directionsOf(links.value)), uplinkBytes: { ingress: rx, egress: tx } };
}

/** Sets the pods' buckets that need it to a limit; a pod that ended meanwhile fails and is left. */
async function apply(shapers: readonly Shaper[], limitBits: number): Promise<void> {
    await Promise.all(
        shapers
            .filter((shaper) => needsChange(shaper, limitBits))
            .map(async (shaper) => {
                const changed = await run('tc', tcArgs(shaper.dev, limitBits));
                if (!changed.ok) {
                    log({ msg: 'cannot set a limit', dev: shaper.dev, error: changed.error });
                }
            }),
    );
}

let last: Snapshot | undefined;
/** The limit last logged per direction, to log changes only. */
const logged: Record<Direction, number> = { ingress: MAX_BITS, egress: MAX_BITS };

async function pass(): Promise<void> {
    const now = await snapshot();
    const before = last;
    last = now ?? last;
    if (now === undefined) {
        return;
    }
    if (before === undefined) {
        // The first reading has no usage to go by: every pod keeps its limit, a limit lowered before a restart too, and gets our burst.
        await Promise.all(now.shapers.map((shaper) => apply([shaper], shaper.rateBits)));
        return;
    }
    const seconds = (now.at - before.at) / 1000;
    const bytesBefore = new Map(before.shapers.map((shaper) => [shaper.dev, shaper.bytes]));
    for (const direction of DIRECTIONS) {
        const shapers = now.shapers.filter((shaper) => shaper.direction === direction);
        const uplinkBits = bitsPerSecond(before.uplinkBytes[direction], now.uplinkBytes[direction], seconds);
        // A pod first seen now has no usage yet.
        const pods = shapers.map((shaper) => ({
            rateBits: shaper.rateBits,
            usageBits: bitsPerSecond(bytesBefore.get(shaper.dev) ?? shaper.bytes, shaper.bytes, seconds),
        }));
        const limitBits = limitFor({ pods, uplinkBits, capacityBits });
        if (Math.abs(limitBits - logged[direction]) >= logged[direction] * 0.05 || (limitBits === MAX_BITS && logged[direction] !== MAX_BITS)) {
            log({ msg: 'limit', direction, mbit: limitBits / 1e6, pods: pods.length, uplinkMbit: Math.round(uplinkBits / 1e6) });
            logged[direction] = limitBits;
        }
        await apply(shapers, limitBits);
    }
}

let stopping = false;
process.once('SIGTERM', () => {
    stopping = true;
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
while (!stopping) {
    await pass();
    await sleep(intervalMs);
}
// Leave no pod below the maximum while nothing watches the uplink.
const final = await snapshot();
await apply(final?.shapers ?? [], MAX_BITS);
log({ msg: 'bandwidth agent stopped; limits back at the maximum' });
