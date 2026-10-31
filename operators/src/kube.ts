/**
 * The few Kubernetes API calls the operators make, behind an interface so the
 * reconcile logic can be tested without a cluster. `kubeFrom` implements it
 * with @kubernetes/client-node; its exceptions end here as `KubeError`s.
 */
import { ApiException, type KubeConfig, KubernetesObjectApi, PatchStrategy } from '@kubernetes/client-node';
import { type Result, err, ok } from './result.js';

/** The operators' field manager name for server-side apply. */
export const FIELD_MANAGER = 'openupstream-operators';

export interface KubeObject {
    readonly apiVersion: string;
    readonly kind: string;
    readonly metadata: {
        readonly name: string;
        readonly namespace?: string;
        readonly labels?: Readonly<Record<string, string>>;
    };
    readonly [field: string]: unknown;
}

export interface ObjectRef {
    readonly apiVersion: string;
    readonly kind: string;
    readonly namespace?: string;
    readonly name: string;
}

export interface KubeError {
    /** HTTP status from the API server; 0 when it was not reached. */
    readonly status: number;
    readonly message: string;
}

export interface Kube {
    /** Server-side apply, forcing ownership of the fields we set. */
    apply(object: KubeObject, options: { readonly dryRun: boolean }): Promise<Result<void, KubeError>>;
    /** A Secret's `data` (base64 values), or undefined when it does not exist. */
    readSecret(namespace: string, name: string): Promise<Result<Record<string, string> | undefined, KubeError>>;
    /** The objects of one kind in all namespaces that carry the labels in `labelSelector`, e.g. `a=b,c=d`. */
    list(apiVersion: string, kind: string, labelSelector: string): Promise<Result<ObjectRef[], KubeError>>;
    /** Deletes the object; one that is already gone counts as deleted. */
    remove(ref: ObjectRef): Promise<Result<void, KubeError>>;
}

export const refOf = (object: KubeObject): ObjectRef => ({
    apiVersion: object.apiVersion,
    kind: object.kind,
    name: object.metadata.name,
    ...(object.metadata.namespace === undefined ? {} : { namespace: object.metadata.namespace }),
});

const kubeError = (error: unknown): KubeError =>
    error instanceof ApiException
        ? { status: error.code, message: messageOf(error.body) ?? error.message }
        : { status: 0, message: error instanceof Error ? error.message : String(error) };

/** JSON from the API server, or undefined when the body is not JSON. */
const parseJson = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

/** The API server puts the reason in a Status object's `message`. */
const messageOf = (body: unknown): string | undefined => {
    const parsed = typeof body === 'string' ? parseJson(body) : body;
    return typeof parsed === 'object' && parsed !== null && 'message' in parsed && typeof parsed.message === 'string'
        ? parsed.message
        : undefined;
};

/**
 * No call may take longer: the client sets no timeout, and a request to an
 * API server in a Site that just went dark would otherwise hang the pass.
 */
export const KUBE_CALL_TIMEOUT_MS = 30_000;

/** Runs a client call and turns its rejection, or its not ending in time, into a KubeError. */
const attemptWithin = <T>(call: () => Promise<T>, timeoutMs: number): Promise<Result<T, KubeError>> => {
    const timedOut = new Promise<Result<T, KubeError>>((resolve) => {
        const timer = setTimeout(() => resolve(err({ status: 0, message: `no answer within ${timeoutMs} ms` })), timeoutMs);
        timer.unref();
    });
    const answered = call().then(
        (value) => ok(value),
        (error: unknown) => err(kubeError(error)),
    );
    return Promise.race([answered, timedOut]);
};

const DRY_RUN_ALL = 'All';

export function kubeFrom(config: KubeConfig, { timeoutMs = KUBE_CALL_TIMEOUT_MS } = {}): Kube {
    const api = KubernetesObjectApi.makeApiClient(config);
    const attempt = <T>(call: () => Promise<T>) => attemptWithin(call, timeoutMs);
    return {
        apply: async (object, { dryRun }) => {
            const result = await attempt(() =>
                api.patch(
                    object,
                    undefined,
                    dryRun ? DRY_RUN_ALL : undefined,
                    FIELD_MANAGER,
                    true,
                    PatchStrategy.ServerSideApply,
                ),
            );
            return result.ok ? ok(undefined) : result;
        },
        readSecret: async (namespace, name) => {
            const result = await attempt(() =>
                api.read<{ apiVersion: string; kind: string; metadata: { name: string; namespace: string }; data?: Record<string, string> }>({
                    apiVersion: 'v1',
                    kind: 'Secret',
                    metadata: { name, namespace },
                }),
            );
            if (!result.ok) {
                return result.error.status === 404 ? ok(undefined) : result;
            }
            return ok(result.value.data ?? {});
        },
        list: async (apiVersion, kind, labelSelector) => {
            const result = await attempt(() =>
                api.list(apiVersion, kind, undefined, undefined, undefined, undefined, undefined, labelSelector),
            );
            if (!result.ok) {
                return result;
            }
            return ok(
                result.value.items.flatMap((item) =>
                    item.metadata?.name === undefined
                        ? []
                        : [
                              {
                                  apiVersion,
                                  kind,
                                  name: item.metadata.name,
                                  ...(item.metadata.namespace === undefined ? {} : { namespace: item.metadata.namespace }),
                              },
                          ],
                ),
            );
        },
        remove: async (ref) => {
            const result = await attempt(() =>
                api.delete({ apiVersion: ref.apiVersion, kind: ref.kind, metadata: { name: ref.name, ...(ref.namespace === undefined ? {} : { namespace: ref.namespace }) } }),
            );
            return result.ok || result.error.status === 404 ? ok(undefined) : result;
        },
    };
}
