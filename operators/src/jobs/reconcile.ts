/**
 * One pass of the Jobs operator: apply what planJobs wants, then delete the
 * objects of ours that it no longer wants (a deleted Job, a Project whose
 * last Job went). Deleting a CronJob deletes its runs, running ones too: a
 * deleted Job runs no more. Pruning only follows a successful listing from
 * the control plane, so a failed fetch never takes anything down.
 */
import type { JobRow } from '@openupstream/sdk';
import type { Kube } from '../kube.js';
import { COMPONENT_LABEL } from '../kubernetes.js';
import { type OwnedReport, applyAndPrune } from '../owned.js';
import { JOBS_COMPONENT, PRUNED_KINDS, planJobs } from './manifests.js';

export async function reconcileJobs(kube: Kube, rows: readonly JobRow[]): Promise<OwnedReport> {
    return applyAndPrune(kube, planJobs(rows), PRUNED_KINDS, `${COMPONENT_LABEL}=${JOBS_COMPONENT}`);
}
