/** A fake Kubernetes for the operators' tests. */
import type { Kube, ObjectRef } from '../kube.js';
import { ok } from '../result.js';

/** A cluster holding `existing` objects of ours; records applies and removes as `<kind> <name>`. */
export const fakeKube = (existing: readonly ObjectRef[]) => {
    const applied: string[] = [];
    const removed: string[] = [];
    const kube: Kube = {
        apply: async (object) => {
            applied.push(`${object.kind} ${object.metadata.name}`);
            return ok(undefined);
        },
        readSecret: async () => ok(undefined),
        list: async (apiVersion, kind) => ok(existing.filter((ref) => ref.apiVersion === apiVersion && ref.kind === kind)),
        remove: async (ref) => {
            removed.push(`${ref.kind} ${ref.name}`);
            return ok(undefined);
        },
    };
    return { kube, applied, removed };
};
