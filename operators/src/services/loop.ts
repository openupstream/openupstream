/**
 * The Services operator: a reconcile pass every interval with the Services
 * from the control plane, run by runPasses (../databases/loop.ts).
 */
import type { FetchServices } from '../control-plane.js';
import type { PassLog } from '../databases/loop.js';
import type { Kube } from '../kube.js';
import { type ListNodes, readNodeBlocks } from '../nodes.js';
import { reconcileServices } from './reconcile.js';

/** One pass, reduced to a log entry. Never throws. */
export async function servicesPass(fetchServices: FetchServices, listNodes: ListNodes, kube: Kube): Promise<PassLog> {
    const rows = await fetchServices();
    if (!rows.ok) {
        // Nothing is applied or deleted without a listing.
        return { msg: 'cannot get the Services', error: rows.error };
    }
    const nodes = await readNodeBlocks(listNodes);
    if (!nodes.ok) {
        // Fail closed (decision 105): pruning would delete the egress policy, and a new Project's pods would start
        // without one, so nothing is applied or deleted and the policies in place keep excluding the nodes they know.
        return { msg: 'cannot get the Nodes, nothing applied', error: nodes.error };
    }
    const { applied, removed, failed } = await reconcileServices(kube, rows.value, nodes.value);
    return {
        msg: 'services pass done',
        services: rows.value.length,
        applied: applied.length,
        ...(removed.length === 0 ? {} : { removed: removed.map((ref) => `${ref.kind} ${ref.namespace}/${ref.name}`) }),
        ...(failed.length === 0 ? {} : { failed }),
    };
}
