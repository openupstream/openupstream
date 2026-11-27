/**
 * Whether the compute Sites have room for a Database (ARCHITECTURE.md,
 * decisions 109 and 110), checked before its row says a size no node can
 * give: disk from TopoLVM's free space, memory and CPU from each node's
 * allocatable less what its pods request (decision 150: an instance requests
 * CPU in proportion to its memory, so the CPU left on a node caps the memory
 * a Database can still take there). A Database the scheduler cannot place
 * stays `provisioning`; a volume TopoLVM cannot grow keeps its old size, and
 * a memory size no node fits leaves the restarted standby Pending, while the
 * row (and the bill) has the new size (dev cluster, 2026-11-15). Racy by
 * nature, as two requests can take the same room; the check catches the
 * plain case.
 *
 * Pure: the caller reads the free bytes per node and where the instances are.
 */
import { COMPUTE_SITES, DATABASE_MILLICORES_PER_GIB, type Site } from '@openupstream/sdk';
import { type Result, err, ok } from '../result.js';

/** Free bytes per node. */
export type NodeRoom = ReadonlyMap<string, number>;

/**
 * A new Database (or a restore) needs `bytes` on a node in each compute
 * Site, one instance per Site. `siteOf` maps the nodes to their Site. The
 * error is the most any Database could get now.
 */
export function roomForNew(room: NodeRoom, siteOf: ReadonlyMap<string, Site>, bytes: number): Result<void, { readonly largest: number }> {
    const largestIn = (site: Site) => Math.max(0, ...[...room].filter(([node]) => siteOf.get(node) === site).map(([, free]) => free));
    const largest = Math.min(...COMPUTE_SITES.map(largestIn));
    return bytes <= largest ? ok(undefined) : err({ largest });
}

/** A grow needs the extra bytes on every node that holds one of the Database's instances. */
export function roomForGrowth(room: NodeRoom, instanceNodes: readonly string[], extraBytes: number): Result<void, { readonly largest: number }> {
    const largest = Math.min(...instanceNodes.map((node) => room.get(node) ?? 0));
    return extraBytes <= largest ? ok(undefined) : err({ largest });
}

export const GiB = 1024 ** 3;
export const MiB = 1024 ** 2;

/**
 * The memory a Database instance could still take on a node: what is free,
 * or less if the node has too little CPU left for that memory's share.
 */
export const databaseMemoryRoom = (free: { readonly memoryBytes: number; readonly cpuMillicores: number }): number =>
    Math.max(0, Math.min(free.memoryBytes, Math.floor((free.cpuMillicores * GiB) / DATABASE_MILLICORES_PER_GIB)));
