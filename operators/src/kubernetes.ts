/**
 * What every operator shares about the cluster: how Sites and Projects appear
 * in Kubernetes, and the shape of a manifest.
 */
import { COMPUTE_SITES, type Id, type Project, projectNamespace as namespaceOf } from '@openupstream/sdk';

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

/**
 * A Project's namespace. Every operator that needs it applies exactly this
 * object: they share one field manager, so a label one of them left out
 * would be removed by its apply.
 */
export const namespaceFor = (project: Pick<Project, 'id' | 'name'>) => ({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
        name: namespaceOf(project.id),
        labels: {
            [LABELS.projectId]: project.id,
            [LABELS.projectName]: project.name,
            [LABELS.managedBy]: MANAGED_BY,
        },
    },
});

/**
 * The namespaces from which a Project's pods accept connections, besides
 * their own: Traefik, which serves the Project's Routes, and CloudNativePG's
 * operator, which asks each Database instance for its status.
 */
export const INGRESS_FROM_NAMESPACES = ['traefik', 'cnpg-system'] as const;

/**
 * Default deny for a Project's namespace (ARCHITECTURE.md, "Project
 * isolation"): its pods accept connections only from each other and from
 * INGRESS_FROM_NAMESPACES, so Projects reach each other only through public
 * Routes, also within one Account. Egress is not restricted here.
 */
export const networkPolicyFor = (projectId: Id) => ({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
        name: 'project-isolation',
        namespace: namespaceOf(projectId),
        labels: { [LABELS.projectId]: projectId, [LABELS.managedBy]: MANAGED_BY },
    },
    spec: {
        podSelector: {},
        policyTypes: ['Ingress'],
        ingress: [
            { from: [{ podSelector: {} }] },
            ...INGRESS_FROM_NAMESPACES.map((name) => ({
                from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': name } } }],
            })),
        ],
    },
});

/**
 * What every operator applies for a Project before anything goes into its
 * namespace, in this order: the namespace, then its NetworkPolicy, so no pod
 * of the Project ever runs unisolated.
 */
export const projectObjectsFor = (project: Pick<Project, 'id' | 'name'>) => [
    namespaceFor(project),
    networkPolicyFor(project.id),
];

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
