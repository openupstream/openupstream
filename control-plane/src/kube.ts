/**
 * What the control plane asks of Kubernetes: a Database's and a Service's
 * state for the API, the deletes of the cleanup (decision 48: deleting is the control
 * plane's explicit step, never the operator's), and the Secrets it renders
 * from its encrypted store (decision 91), since it alone holds the
 * key-encryption key. Every other object is the operators' to create.
 */
import { ApiException, type KubeConfig, KubernetesObjectApi, PatchStrategy } from '@kubernetes/client-node';
import type { DatabaseState, ServiceState } from '@openupstream/sdk';
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

/** The fields of a Service's Deployment that decide its state. */
export interface DeploymentStatus {
    readonly replicas: number;
    readonly generation: number;
    readonly observedGeneration: number;
    readonly updatedReplicas: number;
    readonly availableReplicas: number;
}

/**
 * No Deployment yet, none available, or a rollout under way: deploying;
 * every replica available on the current version: running; else degraded.
 */
export const serviceStateOf = (status: DeploymentStatus | undefined): ServiceState => {
    if (status === undefined || status.availableReplicas === 0) {
        return 'deploying';
    }
    if (status.observedGeneration < status.generation || status.updatedReplicas < status.replicas) {
        return 'deploying';
    }
    return status.availableReplicas >= status.replicas ? 'running' : 'degraded';
};

/** The control plane's field manager for server-side apply; the operators have their own. */
export const FIELD_MANAGER = 'openupstream-control-plane';

/** A Kubernetes Secret as the control plane renders it; `data` values are base64. */
export interface SecretManifest {
    readonly apiVersion: 'v1';
    readonly kind: 'Secret';
    readonly type: string;
    readonly metadata: { readonly name: string; readonly namespace: string; readonly labels: Readonly<Record<string, string>> };
    readonly data: Readonly<Record<string, string>>;
}

export interface ControlPlaneKube {
    /** undefined when the Cluster does not exist (yet). */
    readCluster(namespace: string, name: string): Promise<Result<ClusterStatus | undefined, string>>;
    /** undefined when the Deployment does not exist (yet). */
    readDeployment(namespace: string, name: string): Promise<Result<DeploymentStatus | undefined, string>>;
    /** Deletes an object; one that is already gone counts as deleted. */
    remove(ref: ObjectRef): Promise<Result<void, string>>;
    /**
     * Server-side apply of a Secret. `no-namespace` when its namespace does
     * not exist yet: the operators create it with the Project's first object.
     */
    applySecret(secret: SecretManifest): Promise<Result<'applied' | 'no-namespace', string>>;
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

interface DeploymentObject {
    apiVersion: string;
    kind: string;
    metadata: { name: string; namespace: string; generation?: number };
    spec?: { replicas?: number };
    status?: { observedGeneration?: number; updatedReplicas?: number; availableReplicas?: number };
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
        readDeployment: async (namespace, name) => {
            const result = await within(
                api.read<DeploymentObject>({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace } }),
                timeoutMs,
            );
            if (!result.ok) {
                return result.error.status === NOT_FOUND ? ok(undefined) : err(result.error.message);
            }
            const deployment = result.value;
            return ok({
                replicas: deployment.spec?.replicas ?? 1,
                generation: deployment.metadata.generation ?? 0,
                observedGeneration: deployment.status?.observedGeneration ?? 0,
                updatedReplicas: deployment.status?.updatedReplicas ?? 0,
                availableReplicas: deployment.status?.availableReplicas ?? 0,
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
        applySecret: async (secret) => {
            const result = await within(
                api.patch(secret, undefined, undefined, FIELD_MANAGER, true, PatchStrategy.ServerSideApply),
                timeoutMs,
            );
            if (result.ok) {
                return ok('applied');
            }
            // Applying into a missing namespace answers 404: there is nothing else it could be missing.
            return result.error.status === NOT_FOUND ? ok('no-namespace') : err(result.error.message);
        },
    };
}
