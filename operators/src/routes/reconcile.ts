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
import { type Kube, type KubeError, type KubeObject, type ObjectRef, refOf } from '../kube.js';
import type { Result } from '../result.js';
import { COMPONENT_LABEL, PRUNED_KINDS, ROUTES_COMPONENT, type RoutesSettings, planRoutes } from './manifests.js';

export interface RoutesReport {
    readonly applied: readonly ObjectRef[];
    readonly removed: readonly ObjectRef[];
    readonly failed: readonly { readonly ref: ObjectRef; readonly error: KubeError }[];
}

const keyOf = (ref: ObjectRef): string => `${ref.apiVersion}/${ref.kind}/${ref.namespace ?? ''}/${ref.name}`;

export async function reconcileRoutes(kube: Kube, routings: readonly DomainRouting[], settings: RoutesSettings): Promise<RoutesReport> {
    const wanted = planRoutes(routings, settings);
    // Per Project in order (its namespace before what goes into it, a
    // Middleware before the IngressRoute that names it), Projects side by side.
    const namespaceOf = (object: KubeObject) => object.metadata.namespace ?? object.metadata.name;
    const byNamespace = new Map<string, KubeObject[]>();
    for (const object of wanted) {
        byNamespace.set(namespaceOf(object), [...(byNamespace.get(namespaceOf(object)) ?? []), object]);
    }
    const applyChain = async (chain: readonly KubeObject[]) => {
        const outcomes: { ref: ObjectRef; result: Result<void, KubeError> }[] = [];
        for (const object of chain) {
            outcomes.push({ ref: refOf(object), result: await kube.apply(object, { dryRun: false }) });
        }
        return outcomes;
    };
    const outcomes = (await Promise.all([...byNamespace.values()].map(applyChain))).flat();
    const applied = outcomes.filter(({ result }) => result.ok).map(({ ref }) => ref);
    const failed = outcomes.flatMap(({ ref, result }) => (result.ok ? [] : [{ ref, error: result.error }]));
    const wantedKeys = new Set(wanted.map((object) => keyOf(refOf(object))));
    const removed: ObjectRef[] = [];
    for (const { apiVersion, kind } of PRUNED_KINDS) {
        const listed = await kube.list(apiVersion, kind, `${COMPONENT_LABEL}=${ROUTES_COMPONENT}`);
        if (!listed.ok) {
            failed.push({ ref: { apiVersion, kind, name: '*' }, error: listed.error });
            continue;
        }
        // IngressRoutes come first in PRUNED_KINDS, so a Middleware or Certificate is only deleted after what names it.
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
