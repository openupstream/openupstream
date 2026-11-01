import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    type RegistryDeps,
    credentialKey,
    isForbiddenAddress,
    parseChallenge,
    parseImageReference,
    pinnedImage,
    resolveDigest,
} from './registry.js';

const DIGEST = `sha256:${'b'.repeat(64)}`;

test('references are read as docker pull reads them', () => {
    const cases: [string, unknown][] = [
        ['nginx', { registry: 'docker.io', repository: 'library/nginx', tag: 'latest' }],
        ['nginx:1.27', { registry: 'docker.io', repository: 'library/nginx', tag: '1.27' }],
        ['acme/api:v3', { registry: 'docker.io', repository: 'acme/api', tag: 'v3' }],
        ['ghcr.io/acme/api', { registry: 'ghcr.io', repository: 'acme/api', tag: 'latest' }],
        ['registry.example.com:5000/team/app:2.0', { registry: 'registry.example.com:5000', repository: 'team/app', tag: '2.0' }],
        [`ghcr.io/acme/api@${DIGEST}`, { registry: 'ghcr.io', repository: 'acme/api', digest: DIGEST }],
        [`ghcr.io/acme/api:v1@${DIGEST}`, { registry: 'ghcr.io', repository: 'acme/api', digest: DIGEST }],
    ];
    for (const [reference, expected] of cases) {
        const parsed = parseImageReference(reference);
        assert.ok(parsed.ok, reference);
        assert.deepEqual(parsed.value, expected, reference);
    }
});

test('malformed references are refused', () => {
    for (const reference of ['', 'Nginx', 'nginx:', 'nginx:-x', 'ghcr.io/acme/API', 'nginx@sha256:abc', 'a@b@c', 'x'.repeat(513)]) {
        assert.equal(parseImageReference(reference).ok, false, reference);
    }
});

test('the pinned image and the credential key name the repository', () => {
    const image = parseImageReference('nginx:1.27');
    assert.ok(image.ok);
    assert.equal(pinnedImage(image.value, DIGEST), `docker.io/library/nginx@${DIGEST}`);
    assert.equal(credentialKey(image.value), 'docker.io/library/nginx');
});

test('private, loopback, link-local and cluster addresses are forbidden', () => {
    for (const address of ['10.43.0.1', '10.42.1.7', '127.0.0.1', '169.254.169.254', '192.168.1.1', '172.20.0.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'not-an-ip']) {
        assert.ok(isForbiddenAddress(address), address);
    }
    for (const address of ['140.82.112.33', '2606:50c0:8000::154']) {
        assert.ok(!isForbiddenAddress(address), address);
    }
});

test('a Bearer challenge is parsed', () => {
    assert.deepEqual(parseChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:acme/api:pull"'), {
        scheme: 'bearer',
        params: { realm: 'https://ghcr.io/token', service: 'ghcr.io', scope: 'repository:acme/api:pull' },
    });
});

/** A registry at ghcr.io (public address) that wants a token, granted to `user:pass` for private images. */
const registry = (options: { private?: boolean; noDigestHeader?: boolean; status?: number } = {}) => {
    const calls: { url: string; method: string; authorization: string | null }[] = [];
    const manifest = Buffer.from('{"schemaVersion":2}');
    const deps: RegistryDeps = {
        lookup: async (host) => (host === 'internal.example' ? ['10.43.0.10'] : ['140.82.112.33']),
        fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
            const url = new URL(String(input));
            const headers = new Headers(init?.headers);
            calls.push({ url: url.href, method: init?.method ?? 'GET', authorization: headers.get('authorization') });
            if (url.pathname === '/token') {
                const granted = !options.private || headers.get('authorization') === `Basic ${Buffer.from('user:pass').toString('base64')}`;
                return granted ? Response.json({ token: 'tok' }) : new Response(null, { status: 401 });
            }
            if (headers.get('authorization') !== 'Bearer tok') {
                return new Response(null, {
                    status: 401,
                    headers: { 'www-authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:acme/api:pull"' },
                });
            }
            if (options.status !== undefined) {
                return new Response(null, { status: options.status });
            }
            return new Response(init?.method === 'HEAD' ? null : manifest, {
                status: 200,
                headers: options.noDigestHeader ? {} : { 'docker-content-digest': DIGEST },
            });
        }) as typeof fetch,
    };
    return { deps, calls, manifestDigest: `sha256:${createHash('sha256').update(manifest).digest('hex')}` };
};

const image = (reference: string) => {
    const parsed = parseImageReference(reference);
    assert.ok(parsed.ok);
    return parsed.value;
};

test('a public image: anonymous token, HEAD of the manifest, its digest', async () => {
    const { deps, calls } = registry();
    assert.deepEqual(await resolveDigest(deps, image('ghcr.io/acme/api:v3')), { ok: true, value: DIGEST });
    assert.deepEqual(
        calls.map(({ url, method }) => `${method} ${url}`),
        [
            'HEAD https://ghcr.io/v2/acme/api/manifests/v3',
            'GET https://ghcr.io/token?service=ghcr.io&scope=repository%3Aacme%2Fapi%3Apull',
            'HEAD https://ghcr.io/v2/acme/api/manifests/v3',
        ],
    );
});

test('a private image needs its credentials; without them it is unauthorized', async () => {
    const { deps } = registry({ private: true });
    assert.deepEqual(await resolveDigest(deps, image('ghcr.io/acme/api:v3')), { ok: false, error: { kind: 'unauthorized' } });
    assert.deepEqual(await resolveDigest(deps, image('ghcr.io/acme/api:v3'), { username: 'user', password: 'pass' }), {
        ok: true,
        value: DIGEST,
    });
});

test('without a digest header the manifest itself is hashed', async () => {
    const { deps, manifestDigest } = registry({ noDigestHeader: true });
    assert.deepEqual(await resolveDigest(deps, image('ghcr.io/acme/api:v3')), { ok: true, value: manifestDigest });
});

test('a missing tag is not-found; a failing registry unavailable', async () => {
    assert.deepEqual(await resolveDigest(registry({ status: 404 }).deps, image('ghcr.io/acme/api:nope')), {
        ok: false,
        error: { kind: 'not-found' },
    });
    const failing = await resolveDigest(registry({ status: 502 }).deps, image('ghcr.io/acme/api:v3'));
    assert.equal(failing.ok ? undefined : failing.error.kind, 'unavailable');
});

test('a registry inside the cluster is never called', async () => {
    const { deps, calls } = registry();
    assert.deepEqual(await resolveDigest(deps, image('internal.example/acme/api:v3')), {
        ok: false,
        error: { kind: 'forbidden-address', host: 'internal.example' },
    });
    assert.deepEqual(await resolveDigest(deps, image('10.43.0.10:5000/acme/api:v3')), {
        ok: false,
        error: { kind: 'forbidden-address', host: '10.43.0.10' },
    });
    assert.deepEqual(calls, []);
});

test('a token realm inside the cluster is refused too', async () => {
    const deps: RegistryDeps = {
        lookup: async (host) => (host === 'evil.example' ? ['169.254.169.254'] : ['140.82.112.33']),
        fetch: (async () =>
            new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://evil.example/token"' } })) as typeof fetch,
    };
    assert.deepEqual(await resolveDigest(deps, image('ghcr.io/acme/api:v3')), {
        ok: false,
        error: { kind: 'forbidden-address', host: 'evil.example' },
    });
});

test('a redirect to another host does not carry the credentials along', async () => {
    const seen: { host: string; authorization: string | null }[] = [];
    const deps: RegistryDeps = {
        lookup: async () => ['140.82.112.33'],
        fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
            const url = new URL(String(input));
            const authorization = new Headers(init?.headers).get('authorization');
            seen.push({ host: url.host, authorization });
            if (url.host === 'registry.example' && authorization === null) {
                return new Response(null, { status: 401, headers: { 'www-authenticate': 'Basic realm="r"' } });
            }
            if (url.host === 'registry.example') {
                return new Response(null, { status: 307, headers: { location: 'https://cdn.example/manifest' } });
            }
            return new Response(null, { status: 200, headers: { 'docker-content-digest': DIGEST } });
        }) as typeof fetch,
    };
    assert.deepEqual(await resolveDigest(deps, image('registry.example/acme/api:v1'), { username: 'u', password: 'p' }), {
        ok: true,
        value: DIGEST,
    });
    assert.deepEqual(seen.at(-1), { host: 'cdn.example', authorization: null });
});
