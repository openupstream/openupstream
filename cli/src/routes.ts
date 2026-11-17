/**
 * `oup domain` and `oup route`: which Route an address names, what a Route
 * goes to, and how Domains and Routes are printed. Pure, so it is tested
 * without an API.
 */
import { type Bucket, type Domain, HOSTNAME, PATH_PREFIX, type Route, type RouteInput, type Service } from '@openupstream/sdk';
import { type Result, err, ok } from './result.js';

/** A hostname as typed, the way the API keeps it: lowercase, without a scheme, a path or a final dot. */
export const hostnameOf = (typed: string): string =>
    typed
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '')
        .replace(/\.$/, '');

/** What is wrong with a custom domain's hostname; undefined when nothing is. */
export const hostnameProblem = (hostname: string): string | undefined =>
    HOSTNAME.test(hostname) ? undefined : `${hostname === '' ? 'that' : hostname} is not a hostname; give one like www.example.com`;

/** The Domain `hostname` of the Project. */
export const domainNamed = (domains: readonly Domain[], hostname: string, project: string): Result<Domain, string> => {
    const found = domains.find((domain) => domain.hostname === hostname);
    return found === undefined ? err(`no Domain ${hostname} in ${project}; oup domain list shows them`) : ok(found);
};

/**
 * The Domain and the path prefix an address names: `www.example.com/docs`,
 * `www.example.com` (its `/`), or `/docs` alone for the Project's default
 * Domain. A scheme in front is ignored.
 */
export const parseAddress = (address: string, domains: readonly Domain[], project: string): Result<{ readonly domain: Domain; readonly pathPrefix: string }, string> => {
    const typed = address.trim().replace(/^https?:\/\//, '');
    const slash = typed.indexOf('/');
    const hostname = (slash === -1 ? typed : typed.slice(0, slash)).toLowerCase().replace(/\.$/, '');
    const pathPrefix = slash === -1 ? '/' : typed.slice(slash);
    if (!PATH_PREFIX.test(pathPrefix)) {
        return err(`${pathPrefix} is not a path of a Route: / or /segment[/segment…], without a slash at its end`);
    }
    if (hostname !== '') {
        const domain = domainNamed(domains, hostname, project);
        return domain.ok ? ok({ domain: domain.value, pathPrefix }) : domain;
    }
    const byDefault = domains.find((domain) => domain.kind === 'default');
    return byDefault === undefined ? err(`${project} has no default Domain; name the hostname, as in www.example.com${pathPrefix}`) : ok({ domain: byDefault, pathPrefix });
};

/** What `oup route add` was told the Route goes to. */
export interface TargetFlags {
    readonly bucket?: string | undefined;
    readonly service?: string | undefined;
    readonly spa?: boolean | undefined;
}

/** The Route for the API: to the Bucket or the Service of that name, one of the two. */
export const routeInput = (
    pathPrefix: string,
    flags: TargetFlags,
    buckets: readonly Pick<Bucket, 'id' | 'name'>[],
    services: readonly Pick<Service, 'id' | 'name' | 'port'>[],
    project: string,
): Result<RouteInput, string> => {
    if ((flags.bucket === undefined) === (flags.service === undefined)) {
        return err('a Route goes to one thing: give --bucket <name> or --service <name>');
    }
    if (flags.bucket !== undefined) {
        const bucket = buckets.find((candidate) => candidate.name === flags.bucket);
        return bucket === undefined ? err(`no Bucket ${flags.bucket} in ${project}`) : ok({ pathPrefix, bucketId: bucket.id, spaFallback: flags.spa ?? false });
    }
    if (flags.spa === true) {
        return err('--spa is for a Bucket: a Service answers every path itself');
    }
    const service = services.find((candidate) => candidate.name === flags.service);
    return service === undefined
        ? err(`no Service ${flags.service} in ${project}`)
        : service.port === null
          ? err(`the Service ${service.name} has no port, so it serves no HTTP; give it one with oup service deploy ${service.name} --port <port>`)
          : ok({ pathPrefix, serviceId: service.id });
};

/** Where a custom domain's CNAME points: `ingress.<customer domain>`, the customer domain being what follows the default Domain's first label. */
export const ingressOf = (domains: readonly Domain[]): string | undefined => {
    const hostname = domains.find((domain) => domain.kind === 'default')?.hostname;
    return hostname === undefined ? undefined : `ingress.${hostname.slice(hostname.indexOf('.') + 1)}`;
};

/** Whether a Domain is served: the default one always, a custom one once verified. */
const state = (domain: Domain): string => (domain.kind === 'default' ? 'default' : domain.verification.state === 'verified' ? 'verified' : 'not verified');

export const formatDomains = (domains: readonly Domain[]): string[] => domains.map((domain) => `${domain.hostname.padEnd(48)} ${state(domain)}`);

/** The DNS records a custom domain needs, for one that is not verified yet; nothing for the others. */
export const dnsRecords = (domain: Domain, ingress: string | undefined): string[] =>
    domain.kind === 'custom' && domain.verification.state === 'pending'
        ? [
              `TXT    ${domain.verification.txtRecord.name}   ${domain.verification.txtRecord.value}`,
              ...(ingress === undefined ? [] : [`CNAME  ${domain.hostname}   ${ingress}`]),
          ]
        : [];

/** What a Route goes to, in words; a Resource that is gone by its kind alone. */
const target = (route: Route, buckets: readonly Pick<Bucket, 'id' | 'name'>[], services: readonly Pick<Service, 'id' | 'name'>[]): string => {
    const to = route.target;
    return to.kind === 'bucket'
        ? `Bucket ${buckets.find((bucket) => bucket.id === to.bucketId)?.name ?? '(gone)'}${to.spaFallback ? ' (single-page app)' : ''}`
        : `Service ${services.find((service) => service.id === to.serviceId)?.name ?? '(gone)'}`;
};

/** Every Route as `hostname/path  ->  target`, Domain after Domain; a Domain that is not verified says so, since nothing is served at it. */
export const formatRoutes = (
    domains: readonly Domain[],
    routes: Readonly<Record<string, readonly Route[]>>,
    buckets: readonly Pick<Bucket, 'id' | 'name'>[],
    services: readonly Pick<Service, 'id' | 'name'>[],
): string[] =>
    domains.flatMap((domain) =>
        (routes[domain.id] ?? []).map(
            (route) => `${`${domain.hostname}${route.pathPrefix}`.padEnd(56)} ${target(route, buckets, services)}${state(domain) === 'not verified' ? '   (Domain not verified)' : ''}`,
        ),
    );
