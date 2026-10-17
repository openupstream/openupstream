/**
 * What the control plane asks of Kubernetes: a Database's state for the
 * API, and the deletes of the cleanup (decision 48: deleting is the control
 * plane's explicit step, never the operator's). Creating and updating is the
 * operators' job.
 */
import { ApiException, type KubeConfig, KubernetesObjectApi } from '@kubernetes/client-node';
import type { DatabaseState } from '@openupstream/sdk';
import { type Result, err, ok } from './result.js';

export interface ObjectRef {
    readonly apiVersion: string;
    readonly kind: string;
    readonly namespace?: string;
    readonly name: string;
}

/** The fields of a CloudNativePG Cluster's status that decide its state. */
export interface ClusterStatus {
    readonly instances: number;
    readonly readyInstances: number;
    readonly ready: boolean;
}

export interface ControlPlaneKube {
    /** undefined when the Cluster does not exist (yet). */
    readCluster(namespace: string, name: string): Promise<Result<ClusterStatus | undefined, string>>;
    /** Deletes an object; one that is already gone counts as deleted. */
    remove(ref: ObjectRef): Promise<Result<void, string>>;
}

/** No Cluster yet, or no instance up: provisioning; all up: ready; some: degraded. */
export const stateOf = (status: ClusterStatus | undefined): DatabaseState => {
    if (status === undefined || status.readyInstances === 0) {
        return 'provisioning';
    }
    return status.ready && status.readyInstances >= status.instances ? 'ready' : 'degraded';
};

/** The client sets no timeout; an API server in a dark Site must not hang a request. */
export const KUBE_CALL_TIMEOUT_MS = 10_000;

const NOT_FOUND = 404;

const within = <T>(call: Promise<T>, timeoutMs: number): Promise<Result<T, { status: number; message: string }>> => {
    const timedOut = new Promise<Result<T, { status: number; message: string }>>((resolve) => {
        setTimeout(() => resolve(err({ status: 0, message: `no answer within ${timeoutMs} ms` })), timeoutMs).unref();
    });
    const answered = call.then(
        (value) => ok(value),
        (error: unknown) =>
            err(
                error instanceof ApiException
                    ? { status: error.code, message: error.message }
                    : { status: 0, message: error instanceof Error ? error.message : String(error) },
            ),
    );
    return Promise.race([answered, timedOut]);
};

interface ClusterObject {
    apiVersion: string;
    kind: string;
    metadata: { name: string; namespace: string };
    spec?: { instances?: number };
    status?: { readyInstances?: number; conditions?: { type: string; status: string }[] };
}

export function controlPlaneKube(config: KubeConfig, { timeoutMs = KUBE_CALL_TIMEOUT_MS } = {}): ControlPlaneKube {
    const api = KubernetesObjectApi.makeApiClient(config);
    return {
        readCluster: async (namespace, name) => {
            const result = await within(
                api.read<ClusterObject>({ apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster', metadata: { name, namespace } }),
                timeoutMs,
            );
            if (!result.ok) {
                return result.error.status === NOT_FOUND ? ok(undefined) : err(result.error.message);
            }
            const cluster = result.value;
            return ok({
                instances: cluster.spec?.instances ?? 0,
                readyInstances: cluster.status?.readyInstances ?? 0,
                ready: (cluster.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
            });
        },
        remove: async (ref) => {
            const result = await within(
                api.delete({
                    apiVersion: ref.apiVersion,
                    kind: ref.kind,
                    metadata: ref.namespace === undefined ? { name: ref.name } : { name: ref.name, namespace: ref.namespace },
                }),
                timeoutMs,
            );
            return result.ok || result.error.status === NOT_FOUND ? ok(undefined) : err(result.error.message);
        },
    };
}
