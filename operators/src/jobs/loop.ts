/**
 * The Jobs operator: a reconcile pass every interval with the Jobs from the
 * control plane, run by runPasses (../databases/loop.ts).
 */
import type { FetchJobs } from '../control-plane.js';
import type { PassLog } from '../databases/loop.js';
import type { Kube } from '../kube.js';
import { reconcileJobs } from './reconcile.js';

/** One pass, reduced to a log entry. Never throws. */
export async function jobsPass(fetchJobs: FetchJobs, kube: Kube): Promise<PassLog> {
    const rows = await fetchJobs();
    if (!rows.ok) {
        // Nothing is applied or deleted without a listing.
        return { msg: 'cannot get the Jobs', error: rows.error };
    }
    const { applied, removed, failed } = await reconcileJobs(kube, rows.value);
    return {
        msg: 'jobs pass done',
        jobs: rows.value.length,
        applied: applied.length,
        ...(removed.length === 0 ? {} : { removed: removed.map((ref) => `${ref.kind} ${ref.namespace}/${ref.name}`) }),
        ...(failed.length === 0 ? {} : { failed }),
    };
}
