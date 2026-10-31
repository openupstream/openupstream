/**
 * One pass of the Routes operator: apply what planRoutes wants, then delete
 * the objects of ours that it no longer wants (a deleted Route or Domain).
 *
 * Unlike the Databases operator, this one deletes: these objects hold no
 * data, and a Route that stays after its deletion would keep serving.
 * Pruning only follows a successful listing from the control plane, so a
 * failed fetch never takes anything down. A deleted Project's namespace is
 * removed by the control plane's cleanup, with everything in it.
 */
import type { DomainRouting } from '@openupstream/sdk';
import type { Kube } from '../kube.js';
import { type OwnedReport, applyAndPrune } from '../owned.js';
import { COMPONENT_LABEL, PRUNED_KINDS, ROUTES_COMPONENT, type RoutesSettings, planRoutes } from './manifests.js';

export type RoutesReport = OwnedReport;

export async function reconcileRoutes(kube: Kube, routings: readonly DomainRouting[], settings: RoutesSettings): Promise<RoutesReport> {
    // IngressRoutes come first in PRUNED_KINDS, so a Middleware or Certificate is only deleted after what names it.
    return applyAndPrune(kube, planRoutes(routings, settings), PRUNED_KINDS, `${COMPONENT_LABEL}=${ROUTES_COMPONENT}`);
}
