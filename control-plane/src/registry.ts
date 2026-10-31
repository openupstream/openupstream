/**
 * Resolves an image's tag to its digest at the image's registry
 * (ARCHITECTURE.md, "Containers"; decision 92), so a Service always runs the
 * image it was deployed with, also after a restart or a reschedule.
 *
 * It speaks the OCI Distribution API: a HEAD of the manifest (an index for a
 * multi-platform image, whose digest is what we pin), with the registry's
 * token flow when it answers 401. The registry is the customer's choice, so
 * it is reached over https only, and never at an address inside the cluster
 * or a private network: a Service must not make the control plane call its
 * neighbours. The addresses are checked when the name is looked up; a
 * registry that changes its DNS answer between that check and the request
 * is not caught.
 */
import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { IMAGE_REFERENCE_MAX_LENGTH, type RegistryAuth } from '@openupstream/sdk';
import { type Result, err, ok } from './result.js';

export interface ImageReference {
    /** Host and optional port, as the image names it: `docker.io`, `ghcr.io`, `localhost:5000`. */
    readonly registry: string;
    /** `library/nginx`, `acme/api`. */
    readonly repository: string;
    /** Set when the reference gives no digest; `latest` when it gives neither. */
    readonly tag?: string;
    readonly digest?: string;
}

const DOCKER_HUB = 'docker.io';
/** Docker Hub's API is not served at its name. */
const apiHostOf = (registry: string): string => (registry === DOCKER_HUB ? 'registry-1.docker.io' : registry);

const COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const REPOSITORY = new RegExp(`^${COMPONENT}(?:/${COMPONENT})*$`);
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REGISTRY = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$/;

/** Parses a reference as `docker pull` does: no registry means Docker Hub, a single name there `library/`. */
export function parseImageReference(reference: string): Result<ImageReference, string> {
    if (reference.length === 0 || reference.length > IMAGE_REFERENCE_MAX_LENGTH) {
        return err(`an image reference has 1 to ${IMAGE_REFERENCE_MAX_LENGTH} characters`);
    }
    const [named = '', digest, ...extra] = reference.split('@');
    if (extra.length > 0 || (digest !== undefined && !DIGEST.test(digest))) {
        return err('a digest is sha256:<64 hex digits>');
    }
    const slash = named.indexOf('/');
    const first = slash === -1 ? '' : named.slice(0, slash);
    const hasRegistry = first.includes('.') || first.includes(':') || first === 'localhost';
    const registry = hasRegistry ? first : DOCKER_HUB;
    const rest = hasRegistry ? named.slice(slash + 1) : named;
    const colon = rest.lastIndexOf(':');
    const path = colon === -1 ? rest : rest.slice(0, colon);
    const tag = colon === -1 ? undefined : rest.slice(colon + 1);
    const repository = registry === DOCKER_HUB && !path.includes('/') ? `library/${path}` : path;
    if (!REGISTRY.test(registry)) {
        return err(`not a registry host: ${registry}`);
    }
    if (!REPOSITORY.test(repository)) {
        return err('a repository is lowercase path components of letters, digits and . _ -');
    }
    if (tag !== undefined && !TAG.test(tag)) {
        return err('a tag is up to 128 letters, digits and . _ -, not starting with . or -');
    }
    if (digest !== undefined) {
        return ok({ registry, repository, digest });
    }
    return ok({ registry, repository, tag: tag ?? 'latest' });
}

/** What the Deployment runs: the image by digest, which kubelet pulls and nothing can move. */
export const pinnedImage = (image: ImageReference, digest: string): string => `${image.registry}/${image.repository}@${digest}`;

/** The key of the image's credentials in a dockerconfigjson: kubelet matches it as a prefix of the image. */
export const credentialKey = (image: ImageReference): string => `${image.registry}/${image.repository}`;

export type ResolveError =
    | { readonly kind: 'invalid'; readonly reason: string }
    | { readonly kind: 'not-found' }
    | { readonly kind: 'unauthorized' }
    | { readonly kind: 'forbidden-address'; readonly host: string }
    | { readonly kind: 'unavailable'; readonly reason: string };

export interface RegistryDeps {
    readonly fetch: typeof fetch;
    /** Every address the name resolves to. */
    readonly lookup: (host: string) => Promise<readonly string[]>;
    readonly timeoutMs?: number;
}

export const registryDeps = (): RegistryDeps => ({
    fetch,
    lookup: async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map(({ address }) => address),
});

/** Loopback, private, link-local, shared, multicast and reserved ranges, and the cluster's pod and service networks within them. */
const FORBIDDEN = (() => {
    const list = new BlockList();
    const v4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15', '224.0.0.0/4', '240.0.0.0/4'];
    // IPv4-mapped addresses (::ffff:10.0.0.1) are checked against the IPv4 ranges by BlockList itself.
    const v6 = ['::/127', 'fc00::/7', 'fe80::/10', 'ff00::/8', '64:ff9b::/96'];
    for (const range of v4) {
        const [network = '', prefix = ''] = range.split('/');
        list.addSubnet(network, Number(prefix), 'ipv4');
    }
    for (const range of v6) {
        const [network = '', prefix = ''] = range.split('/');
        list.addSubnet(network, Number(prefix), 'ipv6');
    }
    return list;
})();

export const isForbiddenAddress = (address: string): boolean => {
    const family = isIP(address);
    return family === 0 || FORBIDDEN.check(address, family === 4 ? 'ipv4' : 'ipv6');
};

/** https only, and a host whose every address is public. */
async function checkUrl(deps: RegistryDeps, url: URL): Promise<Result<URL, ResolveError>> {
    if (url.protocol !== 'https:') {
        return err({ kind: 'invalid', reason: `registries are reached over https only, not ${url.protocol}` });
    }
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
    const addresses = isIP(host) === 0 ? await deps.lookup(host).catch(() => undefined) : [host];
    if (addresses === undefined || addresses.length === 0) {
        return err({ kind: 'unavailable', reason: `cannot resolve ${host}` });
    }
    return addresses.some(isForbiddenAddress) ? err({ kind: 'forbidden-address', host }) : ok(url);
}

const MAX_REDIRECTS = 3;

/** A request whose every hop is checked; redirects are followed by hand for that. */
async function guardedFetch(deps: RegistryDeps, url: URL, init: RequestInit): Promise<Result<Response, ResolveError>> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const checked = await checkUrl(deps, current);
        if (!checked.ok) {
            return checked;
        }
        const response = await deps
            .fetch(current, { ...init, redirect: 'manual', signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000) })
            .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
        if (response instanceof Error) {
            return err({ kind: 'unavailable', reason: `${current.host}: ${response.message}` });
        }
        const location = response.headers.get('location');
        if (response.status < 300 || response.status >= 400 || location === null) {
            return ok(response);
        }
        current = new URL(location, current);
    }
    return err({ kind: 'unavailable', reason: 'too many redirects' });
}

/** `Bearer realm="…",service="…",scope="…"` → its parameters. */
export const parseChallenge = (header: string): { scheme: string; params: Record<string, string> } => {
    const [scheme = '', ...rest] = header.trim().split(/\s+/);
    const params = Object.fromEntries([...rest.join(' ').matchAll(/([A-Za-z]+)="([^"]*)"/g)].map(([, key = '', value = '']) => [key.toLowerCase(), value]));
    return { scheme: scheme.toLowerCase(), params };
};

const basic = (auth: RegistryAuth): string => `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;

/** The Authorization header the registry's challenge asks for, or an error. */
async function authorizationFor(
    deps: RegistryDeps,
    challenge: string,
    repository: string,
    auth: RegistryAuth | undefined,
): Promise<Result<string, ResolveError>> {
    const { scheme, params } = parseChallenge(challenge);
    if (scheme === 'basic') {
        return auth === undefined ? err({ kind: 'unauthorized' }) : ok(basic(auth));
    }
    if (scheme !== 'bearer' || params['realm'] === undefined || !URL.canParse(params['realm'])) {
        return err({ kind: 'unavailable', reason: `unsupported authentication challenge: ${scheme}` });
    }
    const realm = new URL(params['realm']);
    if (params['service'] !== undefined) {
        realm.searchParams.set('service', params['service']);
    }
    realm.searchParams.set('scope', params['scope'] ?? `repository:${repository}:pull`);
    const response = await guardedFetch(deps, realm, auth === undefined ? {} : { headers: { authorization: basic(auth) } });
    if (!response.ok) {
        return response;
    }
    if (response.value.status === 401 || response.value.status === 403) {
        return err({ kind: 'unauthorized' });
    }
    if (!response.value.ok) {
        return err({ kind: 'unavailable', reason: `token endpoint answered ${response.value.status}` });
    }
    const body = (await response.value.json().catch(() => ({}))) as { token?: unknown; access_token?: unknown };
    const token = typeof body.token === 'string' ? body.token : body.access_token;
    return typeof token === 'string' ? ok(`Bearer ${token}`) : err({ kind: 'unavailable', reason: 'token endpoint sent no token' });
}

const MANIFEST_TYPES = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** The digest the image's tag points at now (or its digest, once the registry confirms it has it). */
export async function resolveDigest(
    deps: RegistryDeps,
    image: ImageReference,
    auth?: RegistryAuth,
): Promise<Result<string, ResolveError>> {
    const reference = image.digest ?? image.tag ?? 'latest';
    const url = new URL(`https://${apiHostOf(image.registry)}/v2/${image.repository}/manifests/${reference}`);
    const ask = (authorization?: string, method = 'HEAD') =>
        guardedFetch(deps, url, { method, headers: { accept: MANIFEST_TYPES, ...(authorization === undefined ? {} : { authorization }) } });

    let response = await ask();
    if (response.ok && response.value.status === 401) {
        const challenge = response.value.headers.get('www-authenticate');
        if (challenge === null) {
            return err({ kind: 'unauthorized' });
        }
        const authorization = await authorizationFor(deps, challenge, image.repository, auth);
        if (!authorization.ok) {
            return authorization;
        }
        response = await ask(authorization.value);
        if (response.ok && response.value.ok && !response.value.headers.has('docker-content-digest')) {
            // Some registries leave the header out of a HEAD: hash the manifest itself.
            response = await ask(authorization.value, 'GET');
        }
    } else if (response.ok && response.value.ok && !response.value.headers.has('docker-content-digest')) {
        response = await ask(undefined, 'GET');
    }
    if (!response.ok) {
        return response;
    }
    const { status, headers } = response.value;
    if (status === 401 || status === 403) {
        return err({ kind: 'unauthorized' });
    }
    if (status === 404) {
        return err({ kind: 'not-found' });
    }
    if (status !== 200) {
        return err({ kind: 'unavailable', reason: `${image.registry} answered ${status}` });
    }
    const digest =
        headers.get('docker-content-digest') ??
        `sha256:${createHash('sha256').update(Buffer.from(await response.value.arrayBuffer())).digest('hex')}`;
    if (!DIGEST.test(digest)) {
        return err({ kind: 'unavailable', reason: `${image.registry} sent an unsupported digest: ${digest}` });
    }
    if (image.digest !== undefined && digest !== image.digest) {
        return err({ kind: 'unavailable', reason: `${image.registry} answered a different digest than asked for` });
    }
    return ok(digest);
}
