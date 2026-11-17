/**
 * A Project's database tunnel (ARCHITECTURE.md, decision 126; ADR-0005), as
 * a pure function of its id and tunnel host. Applied by the Databases
 * operator for every Project in which a caller has a role, and, like the
 * Databases' own objects, never deleted by it: the forwarder stays once a
 * Project has used the tunnel and goes with the namespace.
 *
 * In the Project's namespace:
 *
 * - the forwarder, a Deployment `database-tunnel` of one pod from the
 *   operators' image (src/forwarder), under gVisor like the customer's own
 *   pods. It copies bytes between a WebSocket and a Database's Pooler or
 *   primary and holds no credentials. It prefers no Site; when its node's
 *   Site fails, Kubernetes starts it in the other one.
 * - a Service of the same name for Traefik;
 * - `database-tunnel-egress`, which lets it reach DNS and its Project's
 *   Databases on 5432 and nothing else. project-isolation already admits
 *   Traefik to it and it to the Databases;
 * - a per-IP rate limit in front of it, as the platform's API has, since
 *   every request costs a call to the control plane, and a ForwardAuth
 *   Middleware that asks the control plane about every tunnel before
 *   Traefik opens it, with the caller's Authorization header and nothing
 *   else of the request;
 * - an IngressRoute at the tunnel host, served with the default TLS
 *   store's wildcard certificate for the customer domain.
 */
import type { Id } from '@openupstream/sdk';
import type { KubeObject } from '../kube.js';
import {
    COMPONENT_LABEL,
    LABELS,
    MANAGED_BY,
    POD_BANDWIDTH_ANNOTATIONS,
    POD_DISK_LIMIT,
    POD_DISK_REQUEST,
    projectNamespace,
    requireComputeSite,
} from '../kubernetes.js';

export const TUNNEL_COMPONENT = 'database-tunnel';
export const TUNNEL_NAME = 'database-tunnel';
export const TUNNEL_AUTH_MIDDLEWARE = 'database-tunnel-auth';
export const TUNNEL_RATE_LIMIT_MIDDLEWARE = 'database-tunnel-rate-limit';
/** Tunnels a client IP may open: a GUI opens several connections at once, a flood of bad tokens is cut before the control plane. */
export const TUNNEL_RATE_LIMIT = { average: 10, period: '1s', burst: 50 } as const;
export const TUNNEL_EGRESS_POLICY = 'database-tunnel-egress';
/** Where the forwarder listens in its pod, and its Service's port. */
export const FORWARDER_PORT = 8080;
export const FORWARDER_ENTRY = 'operators/dist/forwarder/main.js';
const TRAEFIK = 'traefik.io/v1alpha1';

export interface TunnelSettings {
    /** The operators' image, pinned by digest: the forwarder is an entry point of it. */
    readonly forwarderImage: string;
    /** The control plane's tunnel check, which Traefik's ForwardAuth calls: `http://control-plane.<ns>.svc:8080/v1/database-tunnel`. */
    readonly authUrl: string;
}

const labels = (projectId: Id) => ({
    [LABELS.projectId]: projectId,
    [LABELS.managedBy]: MANAGED_BY,
    [COMPONENT_LABEL]: TUNNEL_COMPONENT,
});

const meta = (projectId: Id, name: string) => ({ name, namespace: projectNamespace(projectId), labels: labels(projectId) });

/** CloudNativePG's pods: every Pooler pod carries the first label, every instance the second. */
const DATABASE_PODS = [
    { podSelector: { matchExpressions: [{ key: 'cnpg.io/poolerName', operator: 'Exists' }] } },
    { podSelector: { matchExpressions: [{ key: 'cnpg.io/cluster', operator: 'Exists' }] } },
];

const deployment = (projectId: Id, settings: TunnelSettings): KubeObject => ({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: meta(projectId, TUNNEL_NAME),
    spec: {
        replicas: 1,
        selector: { matchLabels: { [COMPONENT_LABEL]: TUNNEL_COMPONENT } },
        template: {
            metadata: { labels: labels(projectId), annotations: { ...POD_BANDWIDTH_ANNOTATIONS } },
            spec: {
                runtimeClassName: 'gvisor',
                automountServiceAccountToken: false,
                enableServiceLinks: false,
                affinity: { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: requireComputeSite() } },
                securityContext: { runAsNonRoot: true },
                containers: [
                    {
                        name: 'forwarder',
                        image: settings.forwarderImage,
                        command: ['node', FORWARDER_ENTRY],
                        env: [
                            { name: 'PORT', value: String(FORWARDER_PORT) },
                            { name: 'NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } },
                        ],
                        ports: [{ name: 'tunnel', containerPort: FORWARDER_PORT, protocol: 'TCP' }],
                        readinessProbe: { httpGet: { path: '/healthz', port: 'tunnel' }, periodSeconds: 5 },
                        resources: {
                            requests: { cpu: '10m', memory: '64Mi', 'ephemeral-storage': POD_DISK_REQUEST },
                            limits: { memory: '128Mi', 'ephemeral-storage': POD_DISK_LIMIT },
                        },
                        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
                    },
                ],
            },
        },
    },
});

const service = (projectId: Id): KubeObject => ({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: meta(projectId, TUNNEL_NAME),
    spec: {
        selector: { [COMPONENT_LABEL]: TUNNEL_COMPONENT },
        ports: [{ name: 'tunnel', port: FORWARDER_PORT, targetPort: 'tunnel', protocol: 'TCP' }],
    },
});

const egressPolicy = (projectId: Id): KubeObject => ({
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: meta(projectId, TUNNEL_EGRESS_POLICY),
    spec: {
        podSelector: { matchLabels: { [COMPONENT_LABEL]: TUNNEL_COMPONENT } },
        policyTypes: ['Egress'],
        egress: [
            {
                to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }],
                ports: [
                    { port: 53, protocol: 'UDP' },
                    { port: 53, protocol: 'TCP' },
                ],
            },
            { to: DATABASE_PODS, ports: [{ port: 5432, protocol: 'TCP' }] },
        ],
    },
});

const rateLimitMiddleware = (projectId: Id): KubeObject => ({
    apiVersion: TRAEFIK,
    kind: 'Middleware',
    metadata: meta(projectId, TUNNEL_RATE_LIMIT_MIDDLEWARE),
    spec: { rateLimit: { ...TUNNEL_RATE_LIMIT } },
});

const authMiddleware = (projectId: Id, settings: TunnelSettings): KubeObject => ({
    apiVersion: TRAEFIK,
    kind: 'Middleware',
    metadata: meta(projectId, TUNNEL_AUTH_MIDDLEWARE),
    spec: {
        // Only the token goes to the control plane, never a cookie of the request.
        forwardAuth: { address: settings.authUrl, authRequestHeaders: ['Authorization'] },
    },
});

const ingressRoute = (projectId: Id, hostname: string): KubeObject => ({
    apiVersion: TRAEFIK,
    kind: 'IngressRoute',
    metadata: meta(projectId, TUNNEL_NAME),
    spec: {
        entryPoints: ['websecure'],
        routes: [
            {
                match: `Host(\`${hostname}\`)`,
                kind: 'Rule',
                middlewares: [{ name: TUNNEL_RATE_LIMIT_MIDDLEWARE }, { name: TUNNEL_AUTH_MIDDLEWARE }],
                services: [{ name: TUNNEL_NAME, port: FORWARDER_PORT }],
            },
        ],
        // The default TLS store's wildcard for the customer domain covers pg-<project id>.
        tls: {},
    },
});

/** What a Project's tunnel needs, in the order applied: the egress policy before the pod it restricts. */
export const tunnelObjects = (projectId: Id, hostname: string, settings: TunnelSettings): KubeObject[] => [
    egressPolicy(projectId),
    deployment(projectId, settings),
    service(projectId),
    rateLimitMiddleware(projectId),
    authMiddleware(projectId, settings),
    ingressRoute(projectId, hostname),
];
