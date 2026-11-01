/**
 * The pass of an operator that deletes what it no longer wants (the Routes
 * and Services operators): apply every wanted object, then delete the
 * objects carrying its label that are not wanted any more.
 *
 * Objects of one namespace are applied in order (its namespace and
 * NetworkPolicy before what goes into it, a Middleware before the
 * IngressRoute that names it); namespaces side by side. Pruning lists
 * `prunedKinds` in their order, so an object is deleted only after what
 * names it.
 */
import { type Kube, type KubeError, type KubeObject, type ObjectRef, refOf } from './kube.js';
import type { Result } from './result.js';

export interface OwnedReport {
    readonly applied: readonly ObjectRef[];
    readonly removed: readonly ObjectRef[];
    readonly failed: readonly { readonly ref: ObjectRef; readonly error: KubeError }[];
}

const keyOf = (ref: ObjectRef): string => `${ref.apiVersion}/${ref.kind}/${ref.namespace ?? ''}/${ref.name}`;

export async function applyAndPrune(
    kube: Kube,
    wanted: readonly KubeObject[],
    prunedKinds: readonly { readonly apiVersion: string; readonly kind: string }[],
    labelSelector: string,
): Promise<OwnedReport> {
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
    for (const { apiVersion, kind } of prunedKinds) {
        const listed = await kube.list(apiVersion, kind, labelSelector);
        if (!listed.ok) {
            failed.push({ ref: { apiVersion, kind, name: '*' }, error: listed.error });
            continue;
        }
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
