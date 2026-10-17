/**
 * What every operator shares about the cluster: how Sites and Projects appear
 * in Kubernetes, and the shape of a manifest.
 */
import { COMPUTE_SITES, type Id } from '@openupstream/sdk';

/** Each Site is one zone; every node carries its Site's name in this label. */
export const ZONE_LABEL = 'topology.kubernetes.io/zone';

/** The Site that only keeps etcd quorum and a Garage copy. */
export const THIRD_SITE = 'netcup-nbg';

/**
 * Carried by the third Site's node, so that only what tolerates it (etcd and
 * Garage) runs there. Customer facing workloads never tolerate it.
 */
export const THIRD_SITE_TAINT = { key: 'openupstream.io/third-site', value: 'true', effect: 'NoSchedule' } as const;

export const LABELS = {
    projectId: 'openupstream.io/project-id',
    projectName: 'openupstream.io/project-name',
    databaseId: 'openupstream.io/database-id',
    databaseName: 'openupstream.io/database-name',
    managedBy: 'app.kubernetes.io/managed-by',
} as const;

export const MANAGED_BY = 'openupstream-operators';

/** The fields of Kubernetes object metadata the operators set. */
export interface ObjectMeta {
    name: string;
    namespace: string;
    labels: Record<string, string>;
}

/**
 * A generated CRD type with a fixed apiVersion and kind and real metadata
 * (CRD schemas leave metadata untyped). Status belongs to the controller.
 */
export type Manifest<T, ApiVersion extends string, Kind extends string> = Omit<
    T,
    'apiVersion' | 'kind' | 'metadata' | 'status'
> & {
    apiVersion: ApiVersion;
    kind: Kind;
    metadata: ObjectMeta;
};

export { DNS_LABEL, UUID } from '@openupstream/sdk';

// Named by id; the control plane needs the same names, so they live in the sdk.
export { projectNamespace } from '@openupstream/sdk';

/** Restricts pods to the compute Sites, whatever they tolerate. */
export const requireComputeSite = () => ({
    nodeSelectorTerms: [{ matchExpressions: [{ key: ZONE_LABEL, operator: 'In', values: [...COMPUTE_SITES] }] }],
});
