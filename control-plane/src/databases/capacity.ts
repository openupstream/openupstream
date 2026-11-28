/**
 * Whether the compute Sites have room for a Database (ARCHITECTURE.md,
 * decisions 109 and 110), checked before its row says a size no node can
 * give: disk from TopoLVM's free space, memory from each node's allocatable
 * memory less what its pods request. A Database the scheduler cannot place
 * stays `provisioning`; a volume TopoLVM cannot grow keeps its old size, and
 * a memory size no node fits leaves the restarted standby Pending, while the
 * row (and the bill) has the new size (dev cluster, 2026-11-15). Racy by
 * nature, as two requests can take the same room; the check catches the
 * plain case.
 *
 * Pure: the caller reads the free bytes per node and where the instances are.
 */
import type { Site } from '@openupstream/sdk';
import { type Result, err, ok } from '../result.js';

/** Free bytes per node. */
export type NodeRoom = ReadonlyMap<string, number>;

/**
 * A new Database (or a restore) needs `bytes` on a node in its Home site,
 * for the primary, and on a node in one other compute Site, for the standby
 * (ADR-0007). `siteOf` maps the compute nodes to their Site. The error is
 * the most a Database in that Home site could get now.
 */
export function roomForNew(room: NodeRoom, siteOf: ReadonlyMap<string, Site>, home: Site, bytes: number): Result<void, { readonly largest: number }> {
    const largestIn = (site: Site) => Math.max(0, ...[...room].filter(([node]) => siteOf.get(node) === site).map(([, free]) => free));
    const others = [...new Set(siteOf.values())].filter((site) => site !== home);
    const largest = Math.min(largestIn(home), Math.max(0, ...others.map(largestIn)));
    return bytes <= largest ? ok(undefined) : err({ largest });
}

/** A grow needs the extra bytes on every node that holds one of the Database's instances. */
export function roomForGrowth(room: NodeRoom, instanceNodes: readonly string[], extraBytes: number): Result<void, { readonly largest: number }> {
    const largest = Math.min(...instanceNodes.map((node) => room.get(node) ?? 0));
    return extraBytes <= largest ? ok(undefined) : err({ largest });
}

export const GiB = 1024 ** 3;
export const MiB = 1024 ** 2;
