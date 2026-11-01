/**
 * The Traefik objects for the routing table (ARCHITECTURE.md, "Routing and
 * domains"; decision 84), as a pure function of the control plane's rows.
 *
 * Per Project with Routes, in its namespace: the Namespace itself, an
 * ExternalName Service `garage-web` for Garage's website endpoint (Traefik
 * routes only to Services in the IngressRoute's own namespace), and the
 * Middlewares every Domain shares (compression, HSTS). Per Domain: one
 * IngressRoute. Per Route to a Bucket: a Middleware that tells Garage which
 * Bucket to serve (the Host header is the Bucket's name), and one that
 * strips the path prefix.
 *
 * A Route to a Service goes to its Kubernetes Service (decision 93), path
 * unchanged. Like the platform's own routes (infra/ingress), Traefik gives
 * up connecting to a pod after 1 s (the ServersTransport `fail-fast`), so a
 * dark Site's pods do not stall requests, and retries GET and HEAD on
 * another pod; other methods are never resent, since the pod may have acted
 * on them. A Project with a Route to a Service gets both objects.
 *
 * A default Domain uses the default TLS store's wildcard for the customer
 * domain (infra/ingress). A custom domain gets a Certificate of its own,
 * which cert-manager solves with HTTP-01: the ClusterIssuer picks that
 * solver for Certificates carrying COMPONENT_LABEL (decision 85).
 */
import { type DomainRouting, type RoutedPath, ingressRouteName, serviceObjectName } from '@openupstream/sdk';
import type { KubeObject } from '../kube.js';
import { LABELS, MANAGED_BY, projectNamespace, projectObjectsFor } from '../kubernetes.js';

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
    { apiVersion: TRAEFIK, kind: 'ServersTransport' },
    { apiVersion: 'v1', kind: 'Service' },
    { apiVersion: CERT_MANAGER, kind: 'Certificate' },
] as const;

export interface RoutesSettings {
    /** The ClusterIssuer for custom domains' certificates: `letsencrypt`, or `letsencrypt-staging` on a dev cluster. */
    readonly clusterIssuer: string;
}

type Routed = RoutedPath;
type BucketRoute = Extract<RoutedPath, { kind: 'bucket' }>;

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

/** Connecting to a pod gives up after 1 s, so a request finds a live one instead of waiting for a dark Site. */
const FAIL_FAST = 'fail-fast';
const RETRY = 'retry-other-pod';

const servesServices = (routings: readonly DomainRouting[], projectId: string) =>
    routings.some((routing) => routing.projectId === projectId && routing.routes.some((route) => route.kind === 'service'));

/** What a Project's Routes to Services need: the 1 s dial timeout and the retry of GET and HEAD. */
const serviceRoutingObjects = (projectId: string): KubeObject[] => [
    {
        apiVersion: TRAEFIK,
        kind: 'ServersTransport',
        metadata: { name: FAIL_FAST, namespace: projectNamespace(projectId), labels: labels(projectId) },
        spec: { forwardingTimeouts: { dialTimeout: '1s' } },
    },
    middleware(projectId, RETRY, { retry: { attempts: 3, initialInterval: '50ms' } }),
];

/** What a Project's namespace needs once it has a Route. */
const projectObjects = (routing: DomainRouting): KubeObject[] => [
    ...projectObjectsFor({ id: routing.projectId, name: routing.projectName }),
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

const routeObjects = (routing: DomainRouting, route: Routed): KubeObject[] => (route.kind === 'bucket' ? bucketRouteObjects(routing, route) : []);

const bucketRouteObjects = (routing: DomainRouting, route: BucketRoute): KubeObject[] => [
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

/**
 * Traefik orders rules by length unless told otherwise, which would let a
 * long rule at `/` win over a short one at `/api`; the longer prefix always
 * wins here, and of one prefix's two Service rules, the one for GET and HEAD.
 */
export const priorityOf = (pathPrefix: string, safeMethodsOnly: boolean): number =>
    1000 + 2 * (pathPrefix === '/' ? 0 : pathPrefix.length) + (safeMethodsOnly ? 1 : 0);

/** One rule of an IngressRoute. */
interface Rule {
    readonly match: string;
    readonly kind: 'Rule';
    readonly priority: number;
    readonly middlewares: readonly { readonly name: string }[];
    readonly services: readonly { readonly name: string; readonly port: number; readonly serversTransport?: string }[];
}

const bucketRule = (routing: DomainRouting, route: BucketRoute): Rule => ({
    match: matchOf(routing.hostname, route.pathPrefix),
    kind: 'Rule',
    priority: priorityOf(route.pathPrefix, false),
    middlewares: [
        { name: 'hsts' },
        { name: 'compress' },
        ...(route.pathPrefix === '/' ? [] : [{ name: stripMiddlewareName(route) }]),
        { name: hostMiddlewareName(route) },
    ],
    services: [{ name: 'garage-web', port: GARAGE_WEB.port }],
});

const serviceRules = (routing: DomainRouting, route: Extract<RoutedPath, { kind: 'service' }>): Rule[] => {
    const services = [{ name: serviceObjectName({ id: route.serviceId }), port: route.port, serversTransport: FAIL_FAST }];
    const match = matchOf(routing.hostname, route.pathPrefix);
    return [
        {
            match: `${match} && (Method(\`GET\`) || Method(\`HEAD\`))`,
            kind: 'Rule',
            priority: priorityOf(route.pathPrefix, true),
            middlewares: [{ name: 'hsts' }, { name: 'compress' }, { name: RETRY }],
            services,
        },
        { match, kind: 'Rule', priority: priorityOf(route.pathPrefix, false), middlewares: [{ name: 'hsts' }, { name: 'compress' }], services },
    ];
};

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
        routes: routing.routes.flatMap((route): Rule[] => (route.kind === 'bucket' ? [bucketRule(routing, route)] : serviceRules(routing, route))),
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
        ...projects.flatMap((routing) => [
            ...projectObjects(routing),
            ...(servesServices(routings, routing.projectId) ? serviceRoutingObjects(routing.projectId) : []),
        ]),
        ...routings.flatMap((routing) => [
            ...routing.routes.flatMap((route) => routeObjects(routing, route)),
            ...(routing.kind === 'custom' ? [certificate(routing, settings)] : []),
            ingressRoute(routing),
        ]),
    ];
}
