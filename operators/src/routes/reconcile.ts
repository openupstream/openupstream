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
import { type Kube, type KubeError, type ObjectRef, refOf } from '../kube.js';
import { COMPONENT_LABEL, PRUNED_KINDS, ROUTES_COMPONENT, planRoutes } from './manifests.js';

export interface RoutesReport {
    readonly applied: readonly ObjectRef[];
    readonly removed: readonly ObjectRef[];
    readonly failed: readonly { readonly ref: ObjectRef; readonly error: KubeError }[];
}

const keyOf = (ref: ObjectRef): string => `${ref.apiVersion}/${ref.kind}/${ref.namespace ?? ''}/${ref.name}`;

export async function reconcileRoutes(kube: Kube, routings: readonly DomainRouting[]): Promise<RoutesReport> {
    const wanted = planRoutes(routings);
    const applied: ObjectRef[] = [];
    const failed: { ref: ObjectRef; error: KubeError }[] = [];
    // In order: a namespace exists before what goes into it, a Middleware
    // before the IngressRoute that names it.
    for (const object of wanted) {
        const result = await kube.apply(object, { dryRun: false });
        if (result.ok) {
            applied.push(refOf(object));
        } else {
            failed.push({ ref: refOf(object), error: result.error });
        }
    }
    const wantedKeys = new Set(wanted.map((object) => keyOf(refOf(object))));
    const removed: ObjectRef[] = [];
    for (const { apiVersion, kind } of PRUNED_KINDS) {
        const listed = await kube.list(apiVersion, kind, `${COMPONENT_LABEL}=${ROUTES_COMPONENT}`);
        if (!listed.ok) {
            failed.push({ ref: { apiVersion, kind, name: '*' }, error: listed.error });
            continue;
        }
        // IngressRoutes come first in PRUNED_KINDS, so a Middleware is only deleted after what names it.
        for (const ref of listed.value.filter((existing) => !wantedKeys.has(keyOf(existing)))) {
            const result = await kube.remove(ref);
            if (result.ok) {
                removed.push(ref);
            } else {
                failed.push({ ref, error: result.error });
            }
        }
    }
    return { applied, removed, failed };
}
