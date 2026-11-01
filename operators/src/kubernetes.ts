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
 * operator, which asks each Database instance for its status. These are the
 * namespaces infra/dev-cluster installs them into (ingress.sh,
 * operators.sh); moving either one means changing this list first, or the
 * Projects stop being served.
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

/** Which operator's objects, and which kind of customer pod, an object is: `services`, `jobs`, `routes`. */
export const COMPONENT_LABEL = 'openupstream.io/component';

/**
 * Where a customer's container may not connect: loopback, private, shared,
 * link-local, multicast and reserved ranges, which hold the cluster's pod
 * and service networks, the nodes' private addresses and cloud metadata
 * endpoints. The same ranges the control plane refuses to reach a registry
 * at (control-plane/src/registry.ts).
 */
export const EGRESS_EXCEPT_V4 = [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.168.0.0/16',
    '198.18.0.0/15',
    '224.0.0.0/4',
    '240.0.0.0/4',
];
export const EGRESS_EXCEPT_V6 = ['::/127', 'fc00::/7', 'fe80::/10', 'ff00::/8', '64:ff9b::/96'];

/**
 * Where the customer's containers of one kind (`component`, a Service's or
 * a Job's) may connect: DNS, their own namespace (their Databases' Poolers)
 * and the internet, but nothing else inside the cluster or in a private
 * network (decision 93).
 */
export const customerEgressPolicy = (projectId: Id, name: string, component: string, labels: Readonly<Record<string, string>>) => ({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name, namespace: namespaceOf(projectId), labels },
    spec: {
        podSelector: { matchLabels: { [COMPONENT_LABEL]: component } },
        policyTypes: ['Egress'],
        egress: [
            {
                to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
                ports: [
                    { port: 53, protocol: 'UDP' },
                    { port: 53, protocol: 'TCP' },
                ],
            },
            { to: [{ podSelector: {} }] },
            { to: [{ ipBlock: { cidr: '0.0.0.0/0', except: EGRESS_EXCEPT_V4 } }, { ipBlock: { cidr: '::/0', except: EGRESS_EXCEPT_V6 } }] },
        ],
    },
});
