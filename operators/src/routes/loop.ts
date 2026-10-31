/**
 * The Routes operator: a reconcile pass every interval with the routing
 * table from the control plane, run by runPasses (../databases/loop.ts).
 */
import type { FetchRoutings } from '../control-plane.js';
import type { PassLog } from '../databases/loop.js';
import type { Kube } from '../kube.js';
import type { RoutesSettings } from './manifests.js';
import { reconcileRoutes } from './reconcile.js';

/** One pass, reduced to a log entry. Never throws. */
export async function routesPass(fetchRoutings: FetchRoutings, kube: Kube, settings: RoutesSettings): Promise<PassLog> {
    const routings = await fetchRoutings();
    if (!routings.ok) {
        // Nothing is applied or deleted without a listing.
        return { msg: 'cannot get the routing table', error: routings.error };
    }
    const { applied, removed, failed } = await reconcileRoutes(kube, routings.value, settings);
    return {
        msg: 'routes pass done',
        domains: routings.value.length,
        applied: applied.length,
        ...(removed.length === 0 ? {} : { removed: removed.map((ref) => `${ref.kind} ${ref.namespace}/${ref.name}`) }),
        ...(failed.length === 0 ? {} : { failed }),
    };
}
