/**
 * A Project's Services as Kubernetes objects (ARCHITECTURE.md, "Containers";
 * decision 93), as a pure function of the control plane's rows.
 *
 * Per Project with Services, in its namespace: the namespace and its
 * NetworkPolicy, then `service-egress`, which lets the customer's
 * containers reach DNS, their own namespace (their Databases' Poolers) and
 * the internet, but nothing else inside the cluster or in a private network.
 * Per Service: a Deployment `svc-<id>` running the image pinned by digest
 * under the `gvisor` RuntimeClass, and a Kubernetes Service of the same
 * name, which the Routes operator sends its Routes to.
 *
 * Two or more replicas are spread over both compute Sites; a single one
 * prefers its Site (the row's `site`) and moves to the other when that
 * one fails. Every pod reads the Project's Secrets from `project-secrets`
 * and waits for it to exist; the Secrets' version on the pod template rolls
 * the Service when they change.
 */
import {
    PROJECT_REGISTRY_AUTH,
    PROJECT_SECRETS,
    SPEC_VERSION_ANNOTATION,
    type ServiceRow,
    serviceObjectName,
    serviceSpecVersion,
} from '@openupstream/sdk';
import type { KubeObject } from '../kube.js';
import {
    COMPONENT_LABEL,
    LABELS,
    MANAGED_BY,
    ZONE_LABEL,
    customerEgressPolicy,
    projectNamespace,
    projectObjectsFor,
    requireComputeSite,
} from '../kubernetes.js';

export { COMPONENT_LABEL } from '../kubernetes.js';
export const SERVICES_COMPONENT = 'services';
export const SERVICE_ID_LABEL = 'openupstream.io/service-id';
export const SERVICE_NAME_LABEL = 'openupstream.io/service-name';
export const SECRETS_VERSION_ANNOTATION = 'openupstream.io/secrets-version';
export const RUNTIME_CLASS = 'gvisor';

/** The kinds this operator prunes, a Deployment before the Service that fronts it. */
export const PRUNED_KINDS = [
    { apiVersion: 'apps/v1', kind: 'Deployment' },
    { apiVersion: 'v1', kind: 'Service' },
    { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy' },
] as const;

const labels = (projectId: string) => ({
    [LABELS.projectId]: projectId,
    [LABELS.managedBy]: MANAGED_BY,
    [COMPONENT_LABEL]: SERVICES_COMPONENT,
});

/** A single replica prefers its Site; more are spread over both compute Sites. */
const placement = (row: ServiceRow, podLabels: Record<string, string>) =>
    row.service.replicas === 1
        ? {
              affinity: {
                  nodeAffinity: {
                      requiredDuringSchedulingIgnoredDuringExecution: requireComputeSite(),
                      preferredDuringSchedulingIgnoredDuringExecution: [
                          { weight: 100, preference: { matchExpressions: [{ key: ZONE_LABEL, operator: 'In', values: [row.site] }] } },
                      ],
                  },
              },
          }
        : {
              affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: requireComputeSite() } },
              // As for CoreDNS and CloudNativePG's operator (decision 46): a hard spread that leaves out a dark Site's
              // tainted node, so its replicas are replaced in the other Site, and counts only the current rollout's pods.
              topologySpreadConstraints: [
                  {
                      maxSkew: 1,
                      topologyKey: ZONE_LABEL,
                      whenUnsatisfiable: 'DoNotSchedule',
                      nodeTaintsPolicy: 'Honor',
                      labelSelector: { matchLabels: { [SERVICE_ID_LABEL]: podLabels[SERVICE_ID_LABEL] } },
                      matchLabelKeys: ['pod-template-hash'],
                  },
              ],
          };

const deployment = (row: ServiceRow): KubeObject => {
    const { project, service } = row;
    const podLabels = { ...labels(project.id), [SERVICE_ID_LABEL]: service.id, [SERVICE_NAME_LABEL]: service.name };
    const resources = { cpu: `${service.cpuMillicores}m`, memory: `${service.memoryMb}Mi` };
    return {
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata: {
            name: serviceObjectName(service),
            namespace: projectNamespace(project.id),
            labels: podLabels,
            // What the control plane compares with the row to tell whether this change is applied yet.
            annotations: { [SPEC_VERSION_ANNOTATION]: serviceSpecVersion(row) },
        },
        spec: {
            replicas: service.replicas,
            selector: { matchLabels: { [SERVICE_ID_LABEL]: service.id } },
            // A new version starts before an old one stops, so a single replica is never down for a rollout.
            strategy: { type: 'RollingUpdate', rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
            template: {
                metadata: { labels: podLabels, annotations: { [SECRETS_VERSION_ANNOTATION]: row.secretsVersion } },
                spec: {
                    runtimeClassName: RUNTIME_CLASS,
                    automountServiceAccountToken: false,
                    enableServiceLinks: false,
                    imagePullSecrets: [{ name: PROJECT_REGISTRY_AUTH }],
                    ...placement(row, podLabels),
                    containers: [
                        {
                            name: 'app',
                            image: row.pinnedImage,
                            // A worker has no port: nothing probes it, and it is ready once it runs.
                            ...(service.port === null ? {} : { ports: [{ name: 'http', containerPort: service.port, protocol: 'TCP' }] }),
                            envFrom: [{ secretRef: { name: PROJECT_SECRETS } }],
                            // The limits are what is reserved and billed (memory_gb_hours); no Service takes another's CPU.
                            resources: { requests: resources, limits: resources },
                            ...(service.port === null ? {} : { readinessProbe: { tcpSocket: { port: 'http' }, periodSeconds: 5 } }),
                            securityContext: { allowPrivilegeEscalation: false },
                        },
                    ],
                },
            },
        },
    };
};

const kubernetesService = (row: ServiceRow, port: number): KubeObject => ({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
        name: serviceObjectName(row.service),
        namespace: projectNamespace(row.project.id),
        labels: { ...labels(row.project.id), [SERVICE_ID_LABEL]: row.service.id },
    },
    spec: {
        selector: { [SERVICE_ID_LABEL]: row.service.id },
        ports: [{ name: 'http', port, targetPort: 'http', protocol: 'TCP' }],
    },
});

/**
 * Applied in this order, per Project: its namespace, NetworkPolicies, then
 * each Service's Deployment and, when it has a port, its Kubernetes Service.
 */
export function planServices(rows: readonly ServiceRow[]): KubeObject[] {
    const projects = [...new Map(rows.map((row) => [row.project.id, row.project])).values()];
    return [
        ...projects.flatMap((project) => [
            ...projectObjectsFor(project),
            customerEgressPolicy(project.id, 'service-egress', SERVICES_COMPONENT, labels(project.id)),
        ]),
        ...rows.flatMap((row) => [deployment(row), ...(row.service.port === null ? [] : [kubernetesService(row, row.service.port)])]),
    ];
}
