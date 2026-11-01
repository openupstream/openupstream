/**
 * The Services operator: a reconcile pass every interval with the Services
 * from the control plane, run by runPasses (../databases/loop.ts).
 */
import type { FetchServices } from '../control-plane.js';
import type { PassLog } from '../databases/loop.js';
import type { Kube } from '../kube.js';
import { reconcileServices } from './reconcile.js';

/** One pass, reduced to a log entry. Never throws. */
export async function servicesPass(fetchServices: FetchServices, kube: Kube): Promise<PassLog> {
    const rows = await fetchServices();
    if (!rows.ok) {
        // Nothing is applied or deleted without a listing.
        return { msg: 'cannot get the Services', error: rows.error };
    }
    const { applied, removed, failed } = await reconcileServices(kube, rows.value);
    return {
        msg: 'services pass done',
        services: rows.value.length,
        applied: applied.length,
        ...(removed.length === 0 ? {} : { removed: removed.map((ref) => `${ref.kind} ${ref.namespace}/${ref.name}`) }),
        ...(failed.length === 0 ? {} : { failed }),
    };
}
