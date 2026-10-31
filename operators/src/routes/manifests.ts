/**
 * The Traefik objects for the routing table (ARCHITECTURE.md, "Routing and
 * domains"; decision 84), as a pure function of the control plane's rows.
 *
 * Per Project with Routes, in its namespace: the Namespace itself, an
 * ExternalName Service `garage-web` for Garage's website endpoint (Traefik
 * routes only to Services in the IngressRoute's own namespace), and the
 * Middlewares every Domain shares (compression, HSTS). Per Domain: one
 * IngressRoute. Per Route: a Middleware that tells Garage which Bucket to
 * serve (the Host header is the Bucket's name), and one that strips the
 * path prefix.
 *
 * A default Domain uses the default TLS store's wildcard for the customer
 * domain (infra/ingress). A custom domain gets a Certificate of its own,
 * which cert-manager solves with HTTP-01: the ClusterIssuer picks that
 * solver for Certificates carrying COMPONENT_LABEL (decision 85).
 */
import { type DomainRouting, ingressRouteName } from '@openupstream/sdk';
import type { KubeObject } from '../kube.js';
import { LABELS, MANAGED_BY, namespaceFor, projectNamespace } from '../kubernetes.js';

/** Carried by every object this operator applies, so it can find and delete the ones no longer wanted. */
export const COMPONENT_LABEL = 'openupstream.io/component';
export const ROUTES_COMPONENT = 'routes';

/** Where Garage's website endpoint is (infra/garage). */
export const GARAGE_WEB = { host: 'garage.garage.svc.cluster.local', port: 3902 } as const;

export const TRAEFIK = 'traefik.io/v1alpha1';
export const CERT_MANAGER = 'cert-manager.io/v1';

/**
 * The kinds this operator prunes; Namespaces it never deletes. A pruned
 * Certificate's Secret goes with it (cert-manager sets the Certificate as
 * its owner, infra/dev-cluster/operators.sh).
 */
export const PRUNED_KINDS = [
    { apiVersion: TRAEFIK, kind: 'IngressRoute' },
    { apiVersion: TRAEFIK, kind: 'Middleware' },
    { apiVersion: 'v1', kind: 'Service' },
    { apiVersion: CERT_MANAGER, kind: 'Certificate' },
] as const;

export interface RoutesSettings {
    /** The ClusterIssuer for custom domains' certificates: `letsencrypt`, or `letsencrypt-staging` on a dev cluster. */
    readonly clusterIssuer: string;
}

type Routed = DomainRouting['routes'][number];

const labels = (projectId: string) => ({
    [LABELS.projectId]: projectId,
    [LABELS.managedBy]: MANAGED_BY,
    [COMPONENT_LABEL]: ROUTES_COMPONENT,
});

const middleware = (projectId: string, name: string, spec: Record<string, unknown>): KubeObject => ({
    apiVersion: TRAEFIK,
    kind: 'Middleware',
    metadata: { name, namespace: projectNamespace(projectId), labels: labels(projectId) },
    spec,
});

const hostMiddlewareName = (route: Routed) => `route-${route.id}-bucket`;
const stripMiddlewareName = (route: Routed) => `route-${route.id}-strip`;

/** What a Project's namespace needs once it has a Route. */
const projectObjects = (routing: DomainRouting): KubeObject[] => [
    namespaceFor({ id: routing.projectId, name: routing.projectName }),
    {
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: 'garage-web', namespace: projectNamespace(routing.projectId), labels: labels(routing.projectId) },
        spec: { type: 'ExternalName', externalName: GARAGE_WEB.host, ports: [{ name: 'web', port: GARAGE_WEB.port }] },
    },
    middleware(routing.projectId, 'compress', { compress: {} }),
    // Every customer hostname is HTTPS only, like the platform's (decision 68).
    middleware(routing.projectId, 'hsts', { headers: { stsSeconds: 31536000 } }),
];

/** `/` matches everything; `/docs` matches `/docs` and what is below it, not `/docsx`. */
export const matchOf = (hostname: string, pathPrefix: string): string =>
    pathPrefix === '/'
        ? `Host(\`${hostname}\`)`
        : `Host(\`${hostname}\`) && (Path(\`${pathPrefix}\`) || PathPrefix(\`${pathPrefix}/\`))`;

const routeObjects = (routing: DomainRouting, route: Routed): KubeObject[] => [
    // Garage's website endpoint finds the Bucket by the Host header, its global alias.
    middleware(routing.projectId, hostMiddlewareName(route), { headers: { customRequestHeaders: { Host: route.bucketName } } }),
    ...(route.pathPrefix === '/'
        ? []
        : [middleware(routing.projectId, stripMiddlewareName(route), { stripPrefix: { prefixes: [route.pathPrefix] } })]),
];

const certificateName = (routing: DomainRouting) => `domain-${routing.domainId}`;
const tlsSecretName = (routing: DomainRouting) => `${certificateName(routing)}-tls`;

const certificate = (routing: DomainRouting, settings: RoutesSettings): KubeObject => ({
    apiVersion: CERT_MANAGER,
    kind: 'Certificate',
    metadata: { name: certificateName(routing), namespace: projectNamespace(routing.projectId), labels: labels(routing.projectId) },
    spec: {
        secretName: tlsSecretName(routing),
        issuerRef: { kind: 'ClusterIssuer', name: settings.clusterIssuer },
        dnsNames: [routing.hostname],
        privateKey: { algorithm: 'ECDSA', size: 256, rotationPolicy: 'Always' },
    },
});

const ingressRoute = (routing: DomainRouting): KubeObject => ({
    apiVersion: TRAEFIK,
    kind: 'IngressRoute',
    metadata: {
        name: ingressRouteName(routing.domainId),
        namespace: projectNamespace(routing.projectId),
        labels: labels(routing.projectId),
    },
    spec: {
        entryPoints: ['websecure'],
        routes: routing.routes.map((route) => ({
            match: matchOf(routing.hostname, route.pathPrefix),
            kind: 'Rule',
            middlewares: [
                { name: 'hsts' },
                { name: 'compress' },
                ...(route.pathPrefix === '/' ? [] : [{ name: stripMiddlewareName(route) }]),
                { name: hostMiddlewareName(route) },
            ],
            services: [{ name: 'garage-web', port: GARAGE_WEB.port }],
        })),
        // A default Domain: the default TLS store's certificate, the customer domain's wildcard.
        tls: routing.kind === 'custom' ? { secretName: tlsSecretName(routing) } : {},
    },
});

/**
 * Applied in this order: a Project's objects first, then each Domain's
 * Middlewares and Certificate, then its IngressRoute.
 */
export function planRoutes(routings: readonly DomainRouting[], settings: RoutesSettings): KubeObject[] {
    const projects = [...new Map(routings.map((routing) => [routing.projectId, routing])).values()];
    return [
        ...projects.flatMap(projectObjects),
        ...routings.flatMap((routing) => [
            ...routing.routes.flatMap((route) => routeObjects(routing, route)),
            ...(routing.kind === 'custom' ? [certificate(routing, settings)] : []),
            ingressRoute(routing),
        ]),
    ];
}
