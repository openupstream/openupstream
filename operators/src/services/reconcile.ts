/**
 * One pass of the Services operator: apply what planServices wants, then
 * delete the objects of ours that it no longer wants (a deleted Service, a
 * Project whose last Service went). Like the Routes operator it deletes:
 * a Service keeps no data, and one that ran on after its deletion would be
 * billed and served. Pruning only follows a successful listing from the
 * control plane, so a failed fetch never takes anything down.
 */
import type { ServiceRow } from '@openupstream/sdk';
import type { Kube } from '../kube.js';
import { type OwnedReport, applyAndPrune } from '../owned.js';
import { COMPONENT_LABEL, PRUNED_KINDS, SERVICES_COMPONENT, planServices } from './manifests.js';

export async function reconcileServices(kube: Kube, rows: readonly ServiceRow[]): Promise<OwnedReport> {
    return applyAndPrune(kube, planServices(rows), PRUNED_KINDS, `${COMPONENT_LABEL}=${SERVICES_COMPONENT}`);
}
