/**
 * Whether the compute Sites have room for a Database's volumes (ARCHITECTURE.md,
 * decision 109), checked before its row says a size no node can give: a
 * Database the scheduler cannot place stays `provisioning`, and a volume
 * TopoLVM cannot grow keeps the old size while the row (and the bill) has
 * the new one (dev cluster, 2026-11-15). Racy by nature, as two requests
 * can take the same free space; the check catches the plain case.
 *
 * Pure: the caller reads TopoLVM's CSIStorageCapacity per node and where the
 * volumes are.
 */
import { COMPUTE_SITES, type Site } from '@openupstream/sdk';
import { type Result, err, ok } from '../result.js';

const GiB = 1024 ** 3;

/** Free bytes per node, as TopoLVM reports them (its spare already taken off). */
export type NodeCapacity = ReadonlyMap<string, number>;

/** Whole GiB that still fit, rounded down: what the API may promise. */
const wholeGb = (bytes: number): number => Math.floor(bytes / GiB);

/**
 * A new Database (or a restore) needs its size on a node in each compute
 * Site, one instance per Site. `siteOf` maps the nodes TopoLVM reports to
 * their Site.
 */
export function roomForNew(capacity: NodeCapacity, siteOf: ReadonlyMap<string, Site>, storageGb: number): Result<void, { readonly largestGb: number }> {
    const largestIn = (site: Site) =>
        Math.max(0, ...[...capacity].filter(([node]) => siteOf.get(node) === site).map(([, bytes]) => wholeGb(bytes)));
    const largestGb = Math.min(...COMPUTE_SITES.map(largestIn));
    return storageGb <= largestGb ? ok(undefined) : err({ largestGb });
}

/** A grow needs the extra size on every node that holds one of the Database's volumes. */
export function roomForGrowth(capacity: NodeCapacity, volumeNodes: readonly string[], extraGb: number): Result<void, { readonly largestGb: number }> {
    const largestGb = Math.min(...volumeNodes.map((node) => wholeGb(capacity.get(node) ?? 0)));
    return extraGb <= largestGb ? ok(undefined) : err({ largestGb });
}
