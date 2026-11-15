/**
 * The bandwidth agent's arithmetic (ARCHITECTURE.md, "Project isolation";
 * decision 122), as pure functions: which limit the customers' pods on a
 * node get in one direction, from what each sends and how full the node's
 * uplink is, and the `tc` calls that set it.
 *
 * A pod's limit starts at POD_BANDWIDTH_MBIT, set by k3s's CNI when the pod
 * starts: a token bucket (`tbf`) on the pod's interface on the node for
 * what the pod receives, and one on an `ifb` device of its own for what it
 * sends. While the uplink is above TARGET of its speed, every pod on the
 * node gets one lower limit, the fair share: pods below it keep their
 * traffic, and the pods that push against their limit split the rest
 * equally.
 */
import { POD_BANDWIDTH_MBIT } from '../kubernetes.js';

/** From the pod's side, as in the annotations: what it receives and what it sends. */
export type Direction = 'ingress' | 'egress';

/** One pod's token bucket in one direction, as `tc` reports it. */
export interface Shaper {
    readonly dev: string;
    readonly direction: Direction;
    readonly rateBits: number;
    readonly burstBytes: number;
    /** Bytes it has passed since it was created. */
    readonly bytes: number;
}

const MBIT = 1_000_000;
export const MAX_BITS = POD_BANDWIDTH_MBIT * MBIT;
/** No pod goes below this, however full the uplink is. */
export const MIN_BITS = 10 * MBIT;
/** The share of the uplink's speed above which the pods' limits come down. */
export const TARGET = 0.8;
/** A pod sending this share of its limit counts as wanting more than it gets. */
const AT_LIMIT = 0.9;
/** Room a pod below its limit is given to grow into before the next reading. */
const HEADROOM = 1.25;
/** A limit goes up only by this share of itself or more, so `tc` is not called for noise. */
const DEADBAND_UP = 0.05;
/** Going down it follows more closely: what is not applied stays on the uplink above TARGET. */
const DEADBAND_DOWN = 0.01;
/** How long a pod may send at full speed after a pause, at its limit's rate. */
const BURST_SECONDS = 0.1;
/** At least a segment as the kernel hands it over before splitting (GSO). */
const MIN_BURST_BYTES = 64 * 1024;
/** How long a packet may wait in the bucket's queue; the CNI's own value. */
const LATENCY = '25ms';

/** Interface names as the kernel allows them; nothing else is passed to `tc`. */
const DEV = /^[A-Za-z0-9_.-]{1,15}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
/** A JSON list of objects as `ip -j` and `tc -j` print one; anything else is an empty list. */
const parseList = (json: string): Record<string, unknown>[] => {
    const parsed = ((): unknown => {
        try {
            return JSON.parse(json);
        } catch {
            return undefined;
        }
    })();
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
};

/** `ip -j route show default`: the interface of the first default route. */
export function defaultRouteDev(ipRouteJson: string): string | undefined {
    const dev = parseList(ipRouteJson)[0]?.['dev'];
    return typeof dev === 'string' && DEV.test(dev) ? dev : undefined;
}

/**
 * `ip -j -d link show`: which devices are a pod's interface on the node
 * (`veth`, what the pod receives) and which a pod's `ifb` device (what it
 * sends).
 */
export function directionsOf(ipLinkJson: string): ReadonlyMap<string, Direction> {
    return new Map(
        parseList(ipLinkJson).flatMap((link): [string, Direction][] => {
            const kind = isRecord(link['linkinfo']) ? link['linkinfo']['info_kind'] : undefined;
            const name = link['ifname'];
            if (typeof name !== 'string' || !DEV.test(name)) {
                return [];
            }
            return kind === 'veth' ? [[name, 'ingress']] : kind === 'ifb' ? [[name, 'egress']] : [];
        }),
    );
}

/** A token bucket at the root of a device, before it is known whose device it is. */
export type Bucket = Omit<Shaper, 'direction'>;

/**
 * `tc -s -j qdisc show`: the token buckets at the root of a device. Only
 * customers' pods carry the annotations, so only their devices have one.
 */
export function bucketsOf(tcQdiscJson: string): Bucket[] {
    return parseList(tcQdiscJson).flatMap((qdisc): Bucket[] => {
        const { dev, options, bytes } = qdisc;
        if (qdisc['kind'] !== 'tbf' || qdisc['root'] !== true || typeof dev !== 'string' || !DEV.test(dev) || !isRecord(options)) {
            return [];
        }
        const { rate, burst } = options;
        // tc reports the rate in bytes per second.
        return typeof rate === 'number' && typeof burst === 'number' && typeof bytes === 'number' ? [{ dev, rateBits: rate * 8, burstBytes: burst, bytes }] : [];
    });
}

/** The buckets on a pod's device, with their direction; a bucket on any other device is not a pod's and is left alone. */
export const shapersOf = (buckets: readonly Bucket[], directions: ReadonlyMap<string, Direction>): Shaper[] =>
    buckets.flatMap((bucket): Shaper[] => {
        const direction = directions.get(bucket.dev);
        return direction === undefined ? [] : [{ ...bucket, direction }];
    });

/** Bits per second between two readings of a byte counter; a counter that started again counts as 0. */
export const bitsPerSecond = (before: number, now: number, seconds: number): number => (seconds <= 0 ? 0 : (Math.max(0, now - before) * 8) / seconds);

/**
 * The level up to which every demand is met when they share `budget`
 * (max-min fairness): smaller demands are met in full, the others get the
 * level. Infinity when the budget meets them all.
 */
export function fairShare(demands: readonly number[], budget: number): number {
    const sorted = [...demands].sort((a, b) => a - b);
    const fill = (index: number, left: number): number => {
        const demand = sorted[index];
        if (demand === undefined) {
            return Infinity;
        }
        const sharing = sorted.length - index;
        return demand * sharing <= left ? fill(index + 1, left - demand) : Math.max(0, left) / sharing;
    };
    return fill(0, budget);
}

/** One direction on one node at one reading, in bits per second. */
export interface Reading {
    /** Each pod's limit now and what it passed since the last reading. */
    readonly pods: readonly { readonly rateBits: number; readonly usageBits: number }[];
    /** What the node's uplink carried in this direction: the pods' traffic and the platform's. */
    readonly uplinkBits: number;
    /** The uplink's speed; undefined when it is not known, and then nothing is lowered. */
    readonly capacityBits: number | undefined;
}

/**
 * The limit every customer pod on the node gets in this direction, in
 * whole Mbit/s as bits per second.
 *
 * The pods may use what they use now plus what the uplink has left below
 * TARGET (less, when it is above): the platform's own traffic (Database
 * replication, Traefik) is never limited, so the pods give way to it. A
 * pod at its limit is taken to want the maximum, which keeps a lowered
 * limit in place until the pods ask for less or the uplink has room.
 *
 * A bucket counts all of a pod's traffic, and where a packet goes is not
 * known here: traffic that stays on the node (to a Pooler, from Traefik)
 * is limited with the rest while the uplink is full.
 */
export function limitFor({ pods, uplinkBits, capacityBits }: Reading): number {
    if (capacityBits === undefined) {
        return MAX_BITS;
    }
    const used = pods.reduce((sum, pod) => sum + pod.usageBits, 0);
    const budget = used + capacityBits * TARGET - uplinkBits;
    const demands = pods.map((pod) => (pod.usageBits >= pod.rateBits * AT_LIMIT ? MAX_BITS : Math.min(MAX_BITS, pod.usageBits * HEADROOM)));
    const share = Math.min(MAX_BITS, Math.max(MIN_BITS, fairShare(demands, budget)));
    return Math.floor(share / MBIT) * MBIT;
}

/**
 * The bucket's size for a limit. containerd asks the CNI for the largest
 * one there is (512 MB), which lets a pod send that much at the node's
 * full speed before its limit holds (measured on the dev cluster,
 * 2026-11-15: 2.1 Gbit/s for the first two seconds of a 300 Mbit/s limit).
 */
export const burstFor = (rateBits: number): number => Math.max(MIN_BURST_BYTES, Math.round((rateBits / 8) * BURST_SECONDS));

/**
 * Whether a pod's bucket is to be set again: a burst that is not ours (a
 * new pod's), or a limit that moved by more than noise (1% down, 5% up). The kernel keeps
 * the burst as a time, so `tc` reports it a few bytes off.
 */
export function needsChange(shaper: Shaper, limitBits: number): boolean {
    const ours = burstFor(shaper.rateBits);
    if (Math.abs(shaper.burstBytes - ours) > ours * 0.01) {
        return true;
    }
    if (shaper.rateBits === limitBits) {
        return false;
    }
    if (limitBits === MAX_BITS || limitBits === MIN_BITS) {
        return true;
    }
    return limitBits < shaper.rateBits ? shaper.rateBits - limitBits >= shaper.rateBits * DEADBAND_DOWN : limitBits - shaper.rateBits >= shaper.rateBits * DEADBAND_UP;
}

/** `tc`'s arguments that set a pod's bucket to a limit, keeping the bucket and what is queued in it. */
export const tcArgs = (dev: string, limitBits: number): string[] => [
    'qdisc',
    'change',
    'dev',
    dev,
    'root',
    'handle',
    '1:',
    'tbf',
    'rate',
    `${limitBits}bit`,
    'burst',
    `${burstFor(limitBits)}`,
    'latency',
    LATENCY,
];

/** The pods' buckets and the uplink's byte counters at one moment. */
export interface Snapshot {
    /** Seconds on a clock that never steps (not the time of day). */
    readonly at: number;
    readonly shapers: readonly Shaper[];
    /** What the pods receive arrives on the uplink (`rx_bytes`); what they send leaves on it (`tx_bytes`). */
    readonly uplinkBytes: Readonly<Record<Direction, number>>;
}

export const DIRECTIONS: readonly Direction[] = ['ingress', 'egress'];

/** What one pass does: the limit per direction, and the buckets to set to it. */
export interface Plan {
    /** Undefined on the first reading, which decides nothing. */
    readonly limits: Readonly<Record<Direction, number>> | undefined;
    readonly changes: readonly { readonly dev: string; readonly limitBits: number }[];
}

/**
 * From two readings: each direction's limit and the buckets that need
 * setting. The first reading has no usage to go by, so every pod keeps its
 * limit, one lowered before the agent restarted too, and only gets our
 * burst. A pod first seen in `now` has no usage yet.
 */
export function plan(before: Snapshot | undefined, now: Snapshot, capacityBits: number | undefined): Plan {
    if (before === undefined) {
        return { limits: undefined, changes: now.shapers.filter((shaper) => needsChange(shaper, shaper.rateBits)).map((shaper) => ({ dev: shaper.dev, limitBits: shaper.rateBits })) };
    }
    const seconds = now.at - before.at;
    const bytesBefore = new Map(before.shapers.map((shaper) => [shaper.dev, shaper.bytes]));
    const limitOf = (direction: Direction): number =>
        limitFor({
            pods: now.shapers
                .filter((shaper) => shaper.direction === direction)
                .map((shaper) => ({ rateBits: shaper.rateBits, usageBits: bitsPerSecond(bytesBefore.get(shaper.dev) ?? shaper.bytes, shaper.bytes, seconds) })),
            uplinkBits: bitsPerSecond(before.uplinkBytes[direction], now.uplinkBytes[direction], seconds),
            capacityBits,
        });
    const limits = { ingress: limitOf('ingress'), egress: limitOf('egress') };
    return {
        limits,
        changes: now.shapers.filter((shaper) => needsChange(shaper, limits[shaper.direction])).map((shaper) => ({ dev: shaper.dev, limitBits: limits[shaper.direction] })),
    };
}
