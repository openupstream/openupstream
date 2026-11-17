import { BUCKET_NAME, type Bucket, type Domain, HOSTNAME, PATH_PREFIX, type Route, type RouteInput, type Service } from '@openupstream/sdk';

/** What is wrong with a new Bucket's name; undefined when nothing is. The API knows whether another Project has it. */
export const bucketNameProblem = (name: string, existing: readonly Pick<Bucket, 'name'>[]): string | undefined =>
    name === ''
        ? 'Enter a name.'
        : !BUCKET_NAME.test(name)
          ? 'Lowercase letters, digits and hyphens, 3 to 63 characters, starting and ending with a letter or digit, e.g. acme-site.'
          : existing.some((bucket) => bucket.name === name)
            ? `A Bucket named ${name} exists.`
            : undefined;

/** A hostname as typed, the way the API keeps it: without spaces around it, a scheme, a path or a final dot, in lowercase. */
export const hostnameOf = (typed: string): string =>
    typed
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/\.$/, '');

/** What is wrong with a custom domain's hostname; undefined when nothing is. */
export const hostnameProblem = (hostname: string, existing: readonly Pick<Domain, 'hostname'>[]): string | undefined =>
    hostname === ''
        ? 'Enter a hostname.'
        : !HOSTNAME.test(hostname)
          ? 'A hostname of letters, digits and hyphens with at least one dot, e.g. www.example.com.'
          : existing.some((domain) => domain.hostname === hostname)
            ? `This Project has ${hostname} already.`
            : undefined;

/** The customer domain: what follows the first label of the Project's default Domain. */
const customerDomainOf = (defaultHostname: string): string => defaultHostname.slice(defaultHostname.indexOf('.') + 1);

/**
 * Where a custom domain's CNAME points: `ingress.<customer domain>`, the
 * customer domain being what follows the first label of the Project's
 * default Domain.
 */
export const ingressOf = (defaultHostname: string): string => `ingress.${customerDomainOf(defaultHostname)}`;

/** What a Route form holds, as typed. `target` is `bucket:<id>` or `service:<id>`. */
export interface RouteFields {
    readonly pathPrefix: string;
    readonly target: string;
    readonly spaFallback: boolean;
}

export const NEW_ROUTE: RouteFields = { pathPrefix: '/', target: '', spaFallback: false };

/** What a Route can go to: every Bucket, and every Service that has a port. */
export interface Targets {
    readonly buckets: readonly Pick<Bucket, 'id' | 'name'>[];
    readonly services: readonly Pick<Service, 'id' | 'name' | 'port'>[];
}

export const targetOptions = ({ buckets, services }: Targets): readonly { readonly value: string; readonly label: string }[] => [
    ...buckets.map((bucket) => ({ value: `bucket:${bucket.id}`, label: `Bucket ${bucket.name}` })),
    ...services.filter((service) => service.port !== null).map((service) => ({ value: `service:${service.id}`, label: `Service ${service.name}` })),
];

/** The form as a Route for the API; what is wrong with it otherwise. */
export const routeInput = (fields: RouteFields, routes: readonly Pick<Route, 'pathPrefix' | 'target'>[], targets: Targets): RouteInput | string => {
    const pathPrefix = fields.pathPrefix.trim();
    const [kind, id] = fields.target.split(':');
    const chosen = targetOptions(targets).some((option) => option.value === fields.target);
    // Every Route to one Bucket has the same fallback: the Bucket's website settings are one.
    const other = routes.find((route) => route.target.kind === 'bucket' && route.target.bucketId === id);
    return !PATH_PREFIX.test(pathPrefix)
        ? 'The path is / or starts with a slash and has no slash at its end, e.g. /docs.'
        : routes.some((route) => route.pathPrefix === pathPrefix)
          ? `This Domain has a Route at ${pathPrefix}. Delete it first.`
          : !chosen || id === undefined
            ? 'Choose what the Route goes to.'
            : kind === 'service'
              ? { pathPrefix, serviceId: id }
              : other !== undefined && other.target.kind === 'bucket' && other.target.spaFallback !== fields.spaFallback
                ? `The Route ${other.pathPrefix} serves this Bucket ${other.target.spaFallback ? 'with' : 'without'} the fallback to index.html; every Route to one Bucket has the same.`
                : { pathPrefix, bucketId: id, spaFallback: fields.spaFallback };
};

/** What a Route goes to, in words; a Resource the page does not know (deleted meanwhile) by its kind alone. */
export const targetLabel = (route: Pick<Route, 'target'>, { buckets, services }: Targets): string => {
    const { target } = route;
    return target.kind === 'bucket'
        ? `Bucket ${buckets.find((bucket) => bucket.id === target.bucketId)?.name ?? '(gone)'}${target.spaFallback ? ', paths without an object serve index.html' : ''}`
        : `Service ${services.find((service) => service.id === target.serviceId)?.name ?? '(gone)'}`;
};

/** Where S3 clients reach a Bucket: its own hostname, `https://<name>.s3.<customer domain>`. */
export const bucketEndpoint = (name: string, defaultHostname: string): string => `https://${name}.s3.${customerDomainOf(defaultHostname)}`;

/** The addresses a Resource is served at: one per Route to it, on Domains that are routed (the default one, and verified custom ones). */
export const servedAt = (
    kind: 'bucket' | 'service',
    id: string,
    domains: readonly Domain[],
    routes: Readonly<Record<string, readonly Pick<Route, 'pathPrefix' | 'target'>[]>>,
): readonly string[] =>
    domains
        .filter((domain) => domain.kind === 'default' || domain.verification.state === 'verified')
        .flatMap((domain) =>
            (routes[domain.id] ?? [])
                .filter(({ target }) => (target.kind === 'bucket' ? kind === 'bucket' && target.bucketId === id : kind === 'service' && target.serviceId === id))
                .map((route) => `https://${domain.hostname}${route.pathPrefix}`),
        );
