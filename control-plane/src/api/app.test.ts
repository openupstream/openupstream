import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { type CryptoKey, SignJWT, createLocalJWKSet, createRemoteJWKSet, exportJWK, generateKeyPair } from 'jose';
import {
    API_KEY_SCOPES,
    type Account,
    type Bucket,
    type BucketDetails,
    type DatabaseDetails,
    type DatabaseProxy,
    type Domain,
    type JobDetails,
    type JobRun,
    type LogEntry,
    type Member,
    type Project,
    type ProjectUsage,
    type Route,
    type Secret,
    type ServiceDetails,
    type ServiceRow,
    jobSpecVersion,
    serviceSpecVersion,
} from '@openupstream/sdk';
import { getAccountRecord, liftHold, placeHold } from '../accounts/store.js';
import { listDatabaseRows } from '../databases/rows.js';
import { ensureDefaultDomains } from '../domains/store.js';
import { listDomainRoutings } from '../routes/store.js';
import { type ClusterStatus, type ControlPlaneKube, type CronJobStatus, type DeploymentStatus, type KubeJob, type PodInfo, type RecoveryWindow, type SecretManifest } from '../kube.js';
import type { RegistryDeps } from '../registry.js';
import { listServiceRows } from '../services/store.js';
import { listJobRows } from '../jobs/store.js';
import { parseKeyEncryptionKey } from '../secrets/envelope.js';
import type { PrometheusQuery } from '../prometheus.js';
import { err, ok } from '../result.js';
import { cpuQuery, diskQuery, memoryQuery } from '../usage/live.js';
import { type TestDatabase, createTestDatabase } from '../testing/postgres.js';
import { fakeStorage } from '../testing/storage.js';
import { createApi, tunnelProjectOf } from './app.js';
import { type Authenticate, SESSION_TOKEN_TYPE, madauthAuthenticator, sessionVerifier } from './auth.js';

const ISSUER = 'https://openupstream.test';

/** API keys as madAuth would verify them: `madauth_<subject>_<read|write|none>[_<key id>]`. */
const apiKeys: Authenticate = async (key) => {
    const [, subject, scope, keyId] = key.split('_');
    if (subject === undefined || scope === undefined) {
        return err({ kind: 'invalid', reason: 'unknown key' });
    }
    const scopes = scope === 'read' ? [API_KEY_SCOPES.read] : scope === 'write' ? [API_KEY_SCOPES.write] : [];
    return ok({ subject, email: `${subject}@keys.test`, scopes, ...(keyId === undefined ? {} : { apiKeyId: keyId }) });
};

let db: TestDatabase;
const storage = fakeStorage();
let privateKey: CryptoKey;
let otherKey: CryptoKey;
let api: ReturnType<typeof createApi>;
/** What `api` was made from, for a test that needs another setting. */
let apiDeps: Parameters<typeof createApi>[0];
let accountA: string;
let accountB: string;
/** Published TXT records by name, as the fake resolver answers them; `dnsDown` makes it fail. */
const txt = new Map<string, string[]>();
let dnsDown = false;
/** What the fake Prometheus answers, per query. */
let prometheusAnswers: PrometheusQuery = async () => ok([]);
const domainDeps = {
    customerDomain: 'openupstream.test',
    platformDomain: 'platform.test',
    waitlistDomain: 'welcome.test',
    lookupTxt: async (name: string) => (dnsDown ? err('ETIMEOUT') : ok(txt.get(name) ?? [])),
    registry: fakeRegistry(),
    kek: (() => {
        const kek = parseKeyEncryptionKey('test-kek', Buffer.alloc(32, 1).toString('base64'));
        assert.ok(kek.ok);
        return kek.value;
    })(),
};
/**
 * The images the fake registry has, by `repository:tag`, and whether it is up.
 * `acme/private` answers only with Basic credentials `ci:token`.
 */
const images = new Map<string, string>();
let registryDown = false;
function fakeRegistry(): RegistryDeps {
    return {
        lookup: async () => ['140.82.112.33'],
        fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
            if (registryDown) {
                throw new Error('connect ECONNREFUSED');
            }
            const match = /^\/v2\/(.+)\/manifests\/(.+)$/.exec(new URL(String(input)).pathname);
            const [, repository = '', reference = ''] = match ?? [];
            const authorization = new Headers(init?.headers).get('authorization');
            if (repository === 'acme/private' && authorization !== `Basic ${Buffer.from('ci:token').toString('base64')}`) {
                return new Response(null, { status: 401, headers: { 'www-authenticate': 'Basic realm="registry"' } });
            }
            const digest = images.get(`${repository}:${reference}`);
            return digest === undefined
                ? new Response(null, { status: 404 })
                : new Response(null, { status: 200, headers: { 'docker-content-digest': digest } });
        }) as typeof fetch,
    };
}
/** What the fake Kubernetes reports per Deployment name. */
const deployments = new Map<string, DeploymentStatus>();

/** What the fake Kubernetes reports per CronJob name. */
const cronJobs = new Map<string, CronJobStatus>();

/** The Kubernetes Jobs (runs) the fake Kubernetes holds, by name; `kubeDown` makes run calls fail. */
const runs = new Map<string, KubeJob>();
let kubeDown = false;

/** The pods the fake Kubernetes lists, by namespace and label selector, and their log lines (`pod/container`). */
const pods = new Map<string, PodInfo[]>();
const podLogs = new Map<string, string[]>();

/** What the fake Kubernetes reports per Cluster name; a string is an error. */
const clusters = new Map<string, ClusterStatus | string>();

/** TopoLVM's free bytes per node in the fake Kubernetes (undefined: no TopoLVM), the nodes' Sites, and each Cluster's volume nodes. */
let storageCapacity: Map<string, number> | undefined;
const nodeSites = new Map([
    ['node-fsn', 'hetzner-fsn1'],
    ['node-lim', 'ovh-lim'],
]);
const volumeNodes = new Map<string, string[]>();
/** What a new pod could still request per node, in bytes. */
const memoryFree = new Map<string, number>();

/** The recovery windows of the fake Kubernetes' ObjectStores, by name; a string is an error. */
const recoveryWindows = new Map<string, RecoveryWindow | string>();

/** The Secrets the fake Kubernetes received, latest last; namespaces in `missingNamespaces` do not exist. */
const appliedSecrets: SecretManifest[] = [];
/** What the fake Kubernetes was asked to delete through `remove`. */
const removedObjects: { kind: string; namespace?: string; name: string }[] = [];
const missingNamespaces = new Set<string>();
/** When set, the next Secret write into `namespace` calls `reached` and waits for `released` before it lands. */
let secretHold: { readonly namespace: string; readonly reached: () => void; readonly released: Promise<void> } | undefined;

const kube: ControlPlaneKube = {
    readCluster: async (_namespace, name) => {
        const status = clusters.get(name);
        return typeof status === 'string' ? err(status) : ok(status);
    },
    storageCapacity: async () => ok(storageCapacity),
    volumeNodes: async (_namespace, name) => ok(volumeNodes.get(name) ?? []),
    memoryFree: async (node) => ok(memoryFree.get(node)),
    growVolumes: async () => ok([]),
    readRecoveryWindow: async (_namespace, name) => {
        const window = recoveryWindows.get(name);
        return typeof window === 'string' ? err(window) : ok(window);
    },
    readDeployment: async (_namespace, name) => ok(deployments.get(name)),
    readCronJob: async (_namespace, name) => ok(cronJobs.get(name)),
    createJob: async (manifest) => {
        if (kubeDown) {
            return err('connection refused');
        }
        if (runs.has(manifest.metadata.name)) {
            return ok('exists');
        }
        const created = { ...manifest, metadata: { ...manifest.metadata, creationTimestamp: new Date() } };
        runs.set(manifest.metadata.name, created);
        return ok(created);
    },
    listJobs: async (namespace, selector) => {
        if (kubeDown) {
            return err('connection refused');
        }
        const [key = '', value] = selector.split('=');
        return ok([...runs.values()].filter((run) => run.metadata.namespace === namespace && run.metadata.labels?.[key] === value));
    },
    deleteJob: async (_namespace, name) => ok(runs.delete(name) ? 'deleted' : 'not-found'),
    listPods: async (namespace, selector) => (kubeDown ? err('connection refused') : ok(pods.get(`${namespace} ${selector}`) ?? [])),
    nodeSite: async (node) => ok(nodeSites.get(node) ?? 'hetzner-fsn1'),
    podLog: async (_namespace, pod, container, options) => {
        const lines = podLogs.get(`${pod}/${container}`) ?? [];
        const tail = options.tailLines === undefined ? lines : lines.slice(-options.tailLines);
        return ok((async function* () {
            yield* tail;
        })());
    },
    remove: async (ref) => {
        removedObjects.push({ kind: ref.kind, name: ref.name, ...(ref.namespace === undefined ? {} : { namespace: ref.namespace }) });
        return ok(undefined);
    },
    applySecret: async (secret) => {
        const hold = secretHold?.namespace === secret.metadata.namespace ? secretHold : undefined;
        if (hold !== undefined) {
            secretHold = undefined;
            hold.reached();
            await hold.released;
        }
        if (missingNamespaces.has(secret.metadata.namespace)) {
            return ok('no-namespace');
        }
        appliedSecrets.push(secret);
        return ok('applied');
    },
};

/** A session token as madAuth issues it. */
const token = (
    subject: string,
    overrides: { key?: CryptoKey; issuer?: string; typ?: string; expires?: string; email?: string } = {},
) =>
    new SignJWT({ email: overrides.email ?? `${subject}@example.test` })
        .setProtectedHeader({ alg: 'ES256', typ: overrides.typ ?? SESSION_TOKEN_TYPE })
        .setSubject(subject)
        .setIssuer(overrides.issuer ?? ISSUER)
        .setIssuedAt()
        .setExpirationTime(overrides.expires ?? '5m')
        .sign(overrides.key ?? privateKey);

before(async () => {
    db = await createTestDatabase();
    const pair = await generateKeyPair('ES256');
    privateKey = pair.privateKey;
    otherKey = (await generateKeyPair('ES256')).privateKey;
    const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), alg: 'ES256' }] });
    apiDeps = {
        pool: db.pool,
        kube,
        storage,
        ...domainDeps,
        authenticate: madauthAuthenticator(sessionVerifier({ issuer: ISSUER, keys: jwks }), apiKeys),
        cookieSessions: sessionVerifier({ issuer: ISSUER, keys: jwks }),
        logStream: { pollMs: 20, maxMs: 2_000 },
        prometheus: (query) => prometheusAnswers(query),
        databaseVolumes: 'shared',
    };
    api = createApi(apiDeps);
    const accounts = await db.pool.query<{ id: string }>(`insert into accounts (name) values ('A'), ('B') returning id`);
    [accountA, accountB] = accounts.rows.map((row) => row.id) as [string, string];
    // alice is in A; bob in B; carol in both.
    await db.pool.query(
        `insert into members (account_id, auth_subject, email, role) values
         ($1, 'alice', 'alice@a.test', 'owner'), ($2, 'bob', 'bob@b.test', 'owner'),
         ($1, 'carol', 'carol@a.test', 'owner'), ($2, 'carol', 'carol@b.test', 'owner')`,
        [accountA, accountB],
    );
});

after(async () => {
    await db.close();
});

const call = async (method: string, path: string, subject?: string, body?: unknown) =>
    api.request(path, {
        method,
        headers: {
            ...(subject === undefined ? {} : { authorization: `Bearer ${await token(subject)}` }),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

describe('the dashboard: the session cookie from a page of the same origin', () => {
    const withCookie = async (method: string, site: string | undefined, value?: string) =>
        api.request('/v1/projects', {
            method,
            headers: {
                cookie: `other=1; madauth_session=${value ?? (await token('alice'))}`,
                ...(site === undefined ? {} : { 'sec-fetch-site': site }),
                ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
            },
            ...(method === 'POST' ? { body: JSON.stringify({ accountId: accountA, name: 'from-the-dashboard' }) } : {}),
        });

    test('counts as the credential', async () => {
        assert.equal((await withCookie('GET', 'same-origin')).status, 200);
        const created = await withCookie('POST', 'same-origin');
        assert.equal(created.status, 201);
        const { id } = (await created.json()) as { id: string };
        assert.equal((await call('DELETE', `/v1/projects/${id}`, 'alice')).status, 202);
    });

    test('from another site, a subdomain, a navigation or a client that says nothing (CSRF): 401', async () => {
        for (const site of ['cross-site', 'same-site', 'none', undefined]) {
            for (const method of ['GET', 'POST']) {
                assert.equal((await withCookie(method, site)).status, 401, `${method} ${site}`);
            }
        }
    });

    test('must be a session: an API key or a forged token in the cookie is 401', async () => {
        assert.equal((await withCookie('GET', 'same-origin', 'madauth_key')).status, 401);
        assert.equal((await withCookie('GET', 'same-origin', await token('alice', { key: otherKey }))).status, 401);
    });

    test('no other origin is answered with CORS headers; without the setting no cookie is read', async () => {
        const preflight = await api.request('/v1/projects', {
            method: 'OPTIONS',
            headers: { origin: 'https://evil.test', 'access-control-request-method': 'POST' },
        });
        assert.equal(preflight.headers.get('access-control-allow-origin'), null);
        const plain = createApi({ pool: db.pool, kube, storage, ...domainDeps, authenticate: async () => err({ kind: 'invalid', reason: 'none' }) });
        const response = await plain.request('/v1/projects', { headers: { 'sec-fetch-site': 'same-origin', cookie: `madauth_session=${await token('alice')}` } });
        assert.equal(response.status, 401);
    });
});

describe('authentication', () => {
    test('health needs no token', async () => {
        assert.equal((await api.request('/v1/health')).status, 200);
    });

    test("the CLI asks where to sign in without a token; 404 when no CLI client is registered", async () => {
        assert.equal((await api.request('/v1/login')).status, 404);
        const withCli = createApi({
            pool: db.pool,
            kube,
            storage,
            ...domainDeps,
            cliLogin: { issuer: ISSUER, clientId: 'mc_cli' },
            authenticate: async () => err({ kind: 'invalid', reason: 'none' }),
        });
        const response = await withCli.request('/v1/login');
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { issuer: ISSUER, clientId: 'mc_cli' });
    });

    test('no token, a forged token, another issuer, another token type or an expired token: 401', async () => {
        assert.equal((await call('GET', '/v1/projects')).status, 401);
        const bad = [
            await token('alice', { key: otherKey }),
            await token('alice', { issuer: 'https://elsewhere.test' }),
            // e.g. madAuth's renewal token, which must never pass for a session
            await token('alice', { typ: 'madauth-renewal+jwt' }),
            await token('alice', { expires: '-1m' }),
            'madauth_unknown',
        ];
        for (const jwt of bad) {
            const response = await api.request('/v1/projects', { headers: { authorization: `Bearer ${jwt}` } });
            assert.equal(response.status, 401);
        }
    });

    test('when the keys cannot be fetched (madAuth down): 503, not 401', async () => {
        const down = createApi({
            pool: db.pool,
            kube,
            storage,
            ...domainDeps,
            authenticate: sessionVerifier({ issuer: ISSUER, keys: createRemoteJWKSet(new URL('http://127.0.0.1:9/jwks')) }),
        });
        const response = await down.request('/v1/projects', { headers: { authorization: `Bearer ${await token('alice')}` } });
        assert.equal(response.status, 503);
    });

    test('a malformed token: 401', async () => {
        const response = await api.request('/v1/projects', { headers: { authorization: 'Bearer not.a.jwt' } });
        assert.equal(response.status, 401);
    });

    test('a signed-in user who is no Member yet sees no Accounts and no Projects', async () => {
        const accounts = await call('GET', '/v1/accounts', 'newbie');
        assert.equal(accounts.status, 200);
        assert.deepEqual(await accounts.json(), []);
        assert.deepEqual(await (await call('GET', '/v1/projects', 'newbie')).json(), []);
    });
});

describe('API keys', () => {
    const withKey = (key: string, method: string, path: string, body?: unknown) =>
        api.request(path, {
            method,
            headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

    test('openupstream:read may read, not write', async () => {
        assert.equal((await withKey('madauth_alice_read', 'GET', '/v1/projects')).status, 200);
        const write = await withKey('madauth_alice_read', 'POST', '/v1/projects', { accountId: accountA, name: 'by-key' });
        assert.equal(write.status, 403);
        assert.deepEqual(await write.json(), { error: 'this API key lacks the scope openupstream:write' });
    });

    test('openupstream:write may do both', async () => {
        assert.equal((await withKey('madauth_alice_write', 'GET', '/v1/projects')).status, 200);
        const write = await withKey('madauth_alice_write', 'POST', '/v1/projects', { accountId: accountA, name: 'by-key' });
        assert.equal(write.status, 201);
        const { id } = (await write.json()) as Project;
        assert.equal((await withKey('madauth_alice_write', 'DELETE', `/v1/projects/${id}`)).status, 202);
    });

    test('a key with neither scope may do nothing', async () => {
        assert.equal((await withKey('madauth_alice_none', 'GET', '/v1/projects')).status, 403);
    });
});

describe('Accounts', () => {
    test('a signed-in user creates an Account and is its first Member', async () => {
        const response = await call('POST', '/v1/accounts', 'dora', { name: 'Dora GmbH' });
        assert.equal(response.status, 201);
        const account = (await response.json()) as Account;
        assert.equal(account.name, 'Dora GmbH');
        assert.equal(account.role, 'owner');
        assert.equal(response.headers.get('location'), `/v1/accounts/${account.id}`);
        assert.deepEqual(
            ((await (await call('GET', '/v1/accounts', 'dora')).json()) as Account[]).map((a) => a.id),
            [account.id],
        );
        const member = await db.pool.query('select email from members where account_id = $1 and auth_subject = $2', [
            account.id,
            'dora',
        ]);
        assert.deepEqual(member.rows, [{ email: 'dora@example.test' }]);
        // and can work in it at once
        assert.equal((await call('POST', '/v1/projects', 'dora', { accountId: account.id, name: 'web' })).status, 201);
    });

    test('a second Account is a second Account; others see neither', async () => {
        assert.equal((await call('POST', '/v1/accounts', 'dora', { name: 'Dora Labs' })).status, 201);
        assert.equal(((await (await call('GET', '/v1/accounts', 'dora')).json()) as Account[]).length, 2);
        assert.ok(!((await (await call('GET', '/v1/accounts', 'alice')).json()) as Account[]).some((a) => a.name.startsWith('Dora')));
    });

    test("a Member's e-mail follows the address the user has in madAuth now", async () => {
        const jwt = await token('dora', { email: 'dora@new.test' });
        assert.equal((await api.request('/v1/accounts', { headers: { authorization: `Bearer ${jwt}` } })).status, 200);
        const emails = await db.pool.query('select distinct email from members where auth_subject = $1', ['dora']);
        assert.deepEqual(emails.rows, [{ email: 'dora@new.test' }]);
    });

    test('names are 1 to 200 characters', async () => {
        assert.equal((await call('POST', '/v1/accounts', 'dora', { name: '   ' })).status, 400);
        assert.equal((await call('POST', '/v1/accounts', 'dora', { name: 'x'.repeat(201) })).status, 400);
        assert.equal((await call('POST', '/v1/accounts', 'dora', {})).status, 400);
    });
});

describe('Members and their roles', () => {
    let accountId: string;
    let projectId: string;
    const members = (subject: string) => call('GET', `/v1/accounts/${accountId}/members`, subject);
    const memberId = async (subject: string) =>
        (await db.pool.query<{ id: string }>('select id from members where account_id = $1 and auth_subject = $2', [accountId, subject])).rows[0]
            ?.id ?? 'none';
    const withKey = (key: string, method: string, path: string, body?: unknown) =>
        api.request(path, {
            method,
            headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

    before(async () => {
        // No invitations yet: the other Members are inserted as an invitation will.
        accountId = ((await (await call('POST', '/v1/accounts', 'olga', { name: 'Olga AG' })).json()) as Account).id;
        await db.pool.query(
            `insert into members (account_id, auth_subject, email, role, created_at) values
             ($1, 'dev', 'dev@olga.test', 'developer', now() + interval '1 second'),
             ($1, 'nobody', 'nobody@olga.test', null, now() + interval '2 seconds')`,
            [accountId],
        );
        projectId = ((await (await call('POST', '/v1/projects', 'olga', { accountId, name: 'shop' })).json()) as Project).id;
    });

    test('owners and developers see the Members with their roles; others get 404', async () => {
        const listed = (await (await members('dev')).json()) as Member[];
        assert.deepEqual(
            listed.map((member) => [member.email, member.role]),
            [
                ['olga@example.test', 'owner'],
                // each address as the Member's last request brought it from madAuth
                ['dev@example.test', 'developer'],
                ['nobody@olga.test', null],
            ],
        );
        assert.equal((await members('olga')).status, 200);
        assert.equal((await members('nobody')).status, 404);
        assert.equal((await members('bob')).status, 404);
        assert.equal((await call('GET', '/v1/accounts/not-a-uuid/members', 'olga')).status, 404);
        const accounts = (await (await call('GET', '/v1/accounts', 'dev')).json()) as Account[];
        assert.deepEqual(accounts.map((account) => [account.name, account.role]), [['Olga AG', 'developer']]);
    });

    test('a developer works in every Project but changes and removes no Member', async () => {
        assert.equal((await call('GET', `/v1/projects/${projectId}`, 'dev')).status, 200);
        assert.equal((await call('POST', '/v1/projects', 'dev', { accountId, name: 'dev-made' })).status, 201);
        assert.equal((await call('PATCH', `/v1/accounts/${accountId}/members/${await memberId('olga')}`, 'dev', { role: 'developer' })).status, 403);
        assert.equal((await call('DELETE', `/v1/accounts/${accountId}/members/${await memberId('olga')}`, 'dev')).status, 403);
    });

    test('a Member without a role reaches no Project (grants are not built yet)', async () => {
        assert.equal((await call('GET', `/v1/projects/${projectId}`, 'nobody')).status, 404);
        assert.deepEqual(await (await call('GET', '/v1/projects', 'nobody')).json(), []);
        assert.equal((await call('POST', '/v1/projects', 'nobody', { accountId, name: 'sneaky' })).status, 403);
        assert.equal((await call('DELETE', `/v1/accounts/${accountId}/members/${await memberId('dev')}`, 'nobody')).status, 404);
    });

    test('an owner changes roles; a bad role is 400, an unknown Member 404', async () => {
        const path = `/v1/accounts/${accountId}/members/${await memberId('nobody')}`;
        const changed = await call('PATCH', path, 'olga', { role: 'developer' });
        assert.equal(changed.status, 200);
        assert.equal(((await changed.json()) as Member).role, 'developer');
        assert.equal((await call('GET', `/v1/projects/${projectId}`, 'nobody')).status, 200);
        assert.equal((await call('PATCH', path, 'olga', { role: 'admin' })).status, 400);
        assert.equal((await call('PATCH', path, 'olga', {})).status, 400);
        assert.equal((await call('PATCH', `/v1/accounts/${accountId}/members/00000000-0000-4000-8000-000000000000`, 'olga', { role: 'owner' })).status, 404);
        assert.equal((await call('PATCH', `/v1/accounts/${accountId}/members/${await memberId('bob')}`, 'olga', { role: 'owner' })).status, 404);
    });

    test('an API key reads the Members but never changes them, its owner\'s write key neither', async () => {
        assert.equal((await withKey('madauth_olga_read', 'GET', `/v1/accounts/${accountId}/members`)).status, 200);
        const path = `/v1/accounts/${accountId}/members/${await memberId('dev')}`;
        assert.equal((await withKey('madauth_olga_write', 'PATCH', path, { role: 'owner' })).status, 403);
        assert.equal((await withKey('madauth_olga_write', 'DELETE', path)).status, 403);
        assert.equal((await withKey('madauth_dev_write', 'DELETE', `/v1/accounts/${accountId}/members/me`)).status, 403);
    });

    test('the last owner can neither leave nor lose the role; with a second owner they can', async () => {
        const olga = await memberId('olga');
        assert.equal((await call('DELETE', `/v1/accounts/${accountId}/members/me`, 'olga')).status, 409);
        assert.equal((await call('PATCH', `/v1/accounts/${accountId}/members/${olga}`, 'olga', { role: 'developer' })).status, 409);
        assert.equal((await call('PATCH', `/v1/accounts/${accountId}/members/${await memberId('dev')}`, 'olga', { role: 'owner' })).status, 200);
        assert.equal((await call('PATCH', `/v1/accounts/${accountId}/members/${olga}`, 'olga', { role: 'developer' })).status, 200);
        assert.equal((await call('PATCH', `/v1/accounts/${accountId}/members/${olga}`, 'dev', { role: 'owner' })).status, 200);
    });

    test("removing a Member drops their and their keys' Postgres roles; a role given back is a new one", async () => {
        const database = (await (await call('POST', `/v1/projects/${projectId}/databases`, 'olga', { name: 'main', memoryMb: 256, storageGb: 1 })).json()) as DatabaseDetails;
        const proxyPath = `/v1/projects/${projectId}/databases/${database.id}/proxy`;
        const before = (await (await call('POST', proxyPath, 'nobody', { access: 'write' })).json()) as DatabaseProxy;
        assert.equal((await withKey('madauth_nobody_write_k9', 'POST', proxyPath, { access: 'read' })).status, 201);
        assert.equal((await call('POST', proxyPath, 'olga', { access: 'read' })).status, 201);

        removedObjects.length = 0;
        assert.equal((await call('DELETE', `/v1/accounts/${accountId}/members/${await memberId('nobody')}`, 'olga')).status, 204);
        assert.equal((await call('GET', `/v1/projects/${projectId}`, 'nobody')).status, 404);
        const roles = (await listDatabaseRows(db.pool)).find((row) => row.database.id === database.id)?.roles ?? [];
        assert.equal(roles.filter((role) => role.dropped === true).length, 2);
        assert.equal(roles.filter((role) => role.dropped !== true).length, 1, "olga's role stays");
        assert.equal(removedObjects.filter((object) => object.kind === 'Secret' && object.namespace === `project-${projectId}`).length, 2);
        assert.equal((await withKey('madauth_nobody_write_k9', 'POST', proxyPath, { access: 'read' })).status, 404);

        await db.pool.query(`insert into members (account_id, auth_subject, email, role) values ($1, 'nobody', 'nobody@olga.test', 'developer')`, [accountId]);
        const after = await call('POST', proxyPath, 'nobody', { access: 'write' });
        assert.equal(after.status, 201);
        assert.notEqual(((await after.json()) as DatabaseProxy).user, before.user);
    });

    test('anyone may leave; another Member is removed by an owner only, and only once', async () => {
        assert.equal((await call('DELETE', `/v1/accounts/${accountId}/members/me`, 'nobody')).status, 204);
        assert.equal((await call('DELETE', `/v1/accounts/${accountId}/members/me`, 'nobody')).status, 404);
        const dev = await memberId('dev');
        assert.equal((await call('DELETE', `/v1/accounts/${accountId}/members/${dev}`, 'olga')).status, 204);
        assert.equal((await call('DELETE', `/v1/accounts/${accountId}/members/${dev}`, 'olga')).status, 404);
        assert.deepEqual(await (await call('GET', '/v1/accounts', 'dev')).json(), []);
    });
});

describe('Projects', () => {
    let project: Project;

    test('a Member creates a Project in their Account', async () => {
        const response = await call('POST', '/v1/projects', 'alice', { accountId: accountA, name: 'shop-prod' });
        assert.equal(response.status, 201);
        project = (await response.json()) as Project;
        assert.equal(project.accountId, accountA);
        assert.equal(project.name, 'shop-prod');
        assert.equal(response.headers.get('location'), `/v1/projects/${project.id}`);
    });

    test('not in an Account the caller is no Member of', async () => {
        assert.equal((await call('POST', '/v1/projects', 'alice', { accountId: accountB, name: 'x' })).status, 403);
    });

    test('names are DNS labels and unique per Account', async () => {
        const invalid = await call('POST', '/v1/projects', 'alice', { accountId: accountA, name: 'Shop_Prod' });
        assert.equal(invalid.status, 400);
        assert.deepEqual(((await invalid.json()) as { issues: { path: string }[] }).issues.map((i) => i.path), ['name']);
        assert.equal((await call('POST', '/v1/projects', 'alice', { accountId: accountA, name: 'shop-prod' })).status, 409);
        assert.equal((await call('POST', '/v1/projects', 'bob', { accountId: accountB, name: 'shop-prod' })).status, 201);
        assert.equal((await call('POST', '/v1/projects', 'alice', { accountId: accountA })).status, 400);
        assert.equal((await call('POST', '/v1/projects', 'alice', { accountId: accountA, name: 'a', extra: 1 })).status, 400);
    });

    test("each caller sees the Projects of their Accounts; another Account's is not found", async () => {
        const names = async (subject: string) =>
            ((await (await call('GET', '/v1/projects', subject)).json()) as Project[]).map((p) => `${p.accountId === accountA ? 'A' : 'B'}/${p.name}`);
        assert.deepEqual(await names('alice'), ['A/shop-prod']);
        assert.deepEqual(await names('bob'), ['B/shop-prod']);
        assert.deepEqual((await names('carol')).sort(), ['A/shop-prod', 'B/shop-prod']);
        assert.equal((await call('GET', `/v1/projects/${project.id}`, 'alice')).status, 200);
        assert.equal((await call('GET', `/v1/projects/${project.id}`, 'bob')).status, 404);
        assert.equal((await call('GET', '/v1/projects/not-a-uuid', 'alice')).status, 404);
    });
});

describe('Databases', () => {
    let projectId: string;
    let database: DatabaseDetails;

    before(async () => {
        const response = await call('POST', '/v1/projects', 'alice', { accountId: accountA, name: 'db-tests' });
        projectId = ((await response.json()) as Project).id;
    });

    test('created in a Project, provisioning, with its in-cluster connection', async () => {
        const response = await call('POST', `/v1/projects/${projectId}/databases`, 'alice', {
            name: 'orders',
            memoryMb: 512,
            storageGb: 10,
        });
        assert.equal(response.status, 201);
        database = (await response.json()) as DatabaseDetails;
        assert.equal(database.homeSite, 'hetzner-fsn1');
        assert.equal(database.state, 'provisioning');
        assert.deepEqual(database.connection, {
            host: `db-${database.id}-pooler.project-${projectId}.svc.cluster.local`,
            port: 5432,
            database: 'app',
            user: 'app',
        });
        assert.equal(response.headers.get('location'), `/v1/projects/${projectId}/databases/${database.id}`);
    });

    test('the operator sees it at once', async () => {
        assert.ok((await listDatabaseRows(db.pool)).some((row) => row.database.id === database.id));
    });

    test('input is checked: memory floor, Sites, names, duplicates', async () => {
        const post = (body: unknown) => call('POST', `/v1/projects/${projectId}/databases`, 'alice', body);
        assert.equal((await post({ name: 'small', memoryMb: 128, storageGb: 1 })).status, 400);
        assert.equal((await post({ name: 'third', homeSite: 'netcup-nbg', memoryMb: 256, storageGb: 1 })).status, 400);
        assert.equal((await post({ name: 'half', memoryMb: 256.5, storageGb: 1 })).status, 400);
        assert.equal((await post({ name: 'orders', memoryMb: 256, storageGb: 1 })).status, 409);
        assert.equal((await post({ name: 'lim', homeSite: 'ovh-lim', memoryMb: 256, storageGb: 1 })).status, 201);
    });

    test('its state comes from the Cluster, unknown when Kubernetes cannot be asked', async () => {
        const state = async () =>
            ((await (await call('GET', `/v1/projects/${projectId}/databases/${database.id}`, 'alice')).json()) as DatabaseDetails).state;
        clusters.set(`db-${database.id}`, { instances: 2, readyInstances: 2, ready: true });
        assert.equal(await state(), 'ready');
        clusters.set(`db-${database.id}`, { instances: 2, readyInstances: 1, ready: false });
        assert.equal(await state(), 'degraded');
        clusters.set(`db-${database.id}`, 'connect ETIMEDOUT');
        assert.equal(await state(), 'unknown');
        clusters.delete(`db-${database.id}`);
    });

    test("another Account's Member finds nothing", async () => {
        assert.equal((await call('GET', `/v1/projects/${projectId}/databases`, 'bob')).status, 404);
        assert.equal((await call('GET', `/v1/projects/${projectId}/databases/${database.id}`, 'bob')).status, 404);
        assert.equal((await call('DELETE', `/v1/projects/${projectId}/databases/${database.id}`, 'bob')).status, 404);
    });

    test('deleted: gone from the API and from the operator at once, and its name is free again', async () => {
        assert.equal((await call('DELETE', `/v1/projects/${projectId}/databases/${database.id}`, 'alice')).status, 202);
        assert.equal((await call('GET', `/v1/projects/${projectId}/databases/${database.id}`, 'alice')).status, 404);
        assert.equal((await call('DELETE', `/v1/projects/${projectId}/databases/${database.id}`, 'alice')).status, 404);
        assert.ok(!(await listDatabaseRows(db.pool)).some((row) => row.database.id === database.id));
        const listed = (await (await call('GET', `/v1/projects/${projectId}/databases`, 'alice')).json()) as DatabaseDetails[];
        assert.deepEqual(listed.map((d) => d.name), ['lim']);
        const again = await call('POST', `/v1/projects/${projectId}/databases`, 'alice', { name: 'orders', memoryMb: 256, storageGb: 1 });
        assert.equal(again.status, 201);
    });

    test('storage grows by itself by default, without a limit; the customer may set one or turn it off', async () => {
        const post = (body: unknown) => call('POST', `/v1/projects/${projectId}/databases`, 'alice', body);
        const plain = (await (await post({ name: 'grows', memoryMb: 256, storageGb: 2 })).json()) as DatabaseDetails;
        assert.deepEqual([plain.autoGrow, plain.maxStorageGb], [true, null]);
        assert.equal((await post({ name: 'capped', memoryMb: 256, storageGb: 5, maxStorageGb: 4 })).status, 400, 'a maximum below the size');
        const capped = (await (await post({ name: 'capped', memoryMb: 256, storageGb: 5, maxStorageGb: 10, autoGrow: true })).json()) as DatabaseDetails;
        assert.equal(capped.maxStorageGb, 10);

        const patch = (body: unknown) => call('PATCH', `/v1/projects/${projectId}/databases/${capped.id}`, 'alice', body);
        assert.equal((await patch({ maxStorageGb: 4 })).status, 400);
        assert.equal((await patch({ storageGb: 12 })).status, 400, 'storage past the maximum');
        const manual = (await (await patch({ autoGrow: false })).json()) as DatabaseDetails;
        assert.deepEqual([manual.autoGrow, manual.maxStorageGb], [false, 10], 'the maximum stays');
        const unlimited = (await (await patch({ maxStorageGb: null, autoGrow: true })).json()) as DatabaseDetails;
        assert.deepEqual([unlimited.autoGrow, unlimited.maxStorageGb], [true, null]);
        const row = (await listDatabaseRows(db.pool)).find((r) => r.database.id === capped.id);
        assert.deepEqual([row?.database.autoGrow, row?.database.maxStorageGb], [true, null]);
    });

    test('resized: storage only grows, memory either way; resizing until the Cluster has the new sizes', async () => {
        const created = (await (
            await call('POST', `/v1/projects/${projectId}/databases`, 'alice', { name: 'sized', memoryMb: 512, storageGb: 5 })
        ).json()) as DatabaseDetails;
        const patch = (body: unknown, who = 'alice') => call('PATCH', `/v1/projects/${projectId}/databases/${created.id}`, who, body);
        clusters.set(`db-${created.id}`, { instances: 2, readyInstances: 2, ready: true, memoryMb: 512, storageGb: 5 });

        assert.equal((await patch({ storageGb: 4 })).status, 400, 'a volume cannot shrink');
        assert.equal((await patch({})).status, 400);
        assert.equal((await patch({ memoryMb: 128 })).status, 400, 'below the floor');
        assert.equal((await patch({ storageGb: 10 }, 'bob')).status, 404);

        const grown = await patch({ storageGb: 10, memoryMb: 1024 });
        assert.equal(grown.status, 200);
        const details = (await grown.json()) as DatabaseDetails;
        assert.deepEqual([details.storageGb, details.memoryMb, details.state], [10, 1024, 'resizing']);
        const row = (await listDatabaseRows(db.pool)).find((r) => r.database.id === created.id);
        assert.deepEqual([row?.database.storageGb, row?.database.memoryMb], [10, 1024], 'the operator renders the new sizes');

        const GiB = 1024 ** 3;
        storageCapacity = new Map([
            ['node-fsn', 30 * GiB],
            ['node-lim', 14.5 * GiB],
        ]);
        volumeNodes.set(`db-${created.id}`, ['node-fsn', 'node-lim']);
        const MiB = 1024 ** 2;
        memoryFree.set('node-fsn', 4096 * MiB).set('node-lim', 1500 * MiB);
        const tooMuchMemory = await patch({ memoryMb: 2560 });
        assert.equal(tooMuchMemory.status, 507, 'ovh-lim has 1500 MB free, the instance needs 1536 MB more');
        assert.match(((await tooMuchMemory.json()) as { error: string }).error, /at most 1500 MB more/);
        const tooBig = await patch({ storageGb: 25 });
        assert.equal(tooBig.status, 507, 'ovh-lim has room for 14 GB more, not 15');
        assert.match(((await tooBig.json()) as { error: string }).error, /at most 14 GB more/);
        assert.equal(
            (await call('POST', `/v1/projects/${projectId}/databases`, 'alice', { name: 'huge', memoryMb: 256, storageGb: 15 })).status,
            507,
            'a new one needs room in both Sites',
        );
        assert.equal(
            (await call('POST', `/v1/projects/${projectId}/databases`, 'alice', { name: 'hungry', memoryMb: 2048, storageGb: 1 })).status,
            507,
            'and memory in both Sites',
        );
        volumeNodes.delete(`db-${created.id}`);
        assert.equal((await patch({ storageGb: 14 })).status, 200, 'no volumes yet: room in both Sites as for a new one');
        assert.equal((await patch({ storageGb: 15 })).status, 507);
        storageCapacity = undefined;
        memoryFree.clear();

        clusters.set(`db-${created.id}`, { instances: 2, readyInstances: 2, ready: true, memoryMb: 1024, storageGb: 14 });
        const state = async () =>
            ((await (await call('GET', `/v1/projects/${projectId}/databases/${created.id}`, 'alice')).json()) as DatabaseDetails).state;
        assert.equal(await state(), 'ready');

        assert.equal(await placeHold(db.pool, accountA, 'unpaid'), true);
        assert.equal((await patch({ storageGb: 20 })).status, 402, 'growing costs more');
        assert.equal((await patch({ memoryMb: 512 })).status, 200, 'shrinking memory is allowed while held');
        assert.equal(await liftHold(db.pool, accountA, 'unpaid'), true);
        clusters.delete(`db-${created.id}`);
    });

    test('restored from another Database of the Project, live or deleted, within its recovery window', async () => {
        const post = (body: unknown) => call('POST', `/v1/projects/${projectId}/databases`, 'alice', body);
        const source = (await (await post({ name: 'source', memoryMb: 256, storageGb: 2 })).json()) as DatabaseDetails;
        const restore = (name: string, restoreFrom: unknown) => post({ name, memoryMb: 256, storageGb: 2, restoreFrom });
        const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

        assert.equal((await restore('early', { databaseId: source.id })).status, 409, 'no ObjectStore yet');
        recoveryWindows.set(`db-${source.id}`, { firstRecoverabilityPoint: undefined, lastSuccessfulBackupTime: undefined });
        assert.equal((await restore('early', { databaseId: source.id })).status, 409, 'no finished base backup yet');

        recoveryWindows.set(`db-${source.id}`, { firstRecoverabilityPoint: minutesAgo(60), lastSuccessfulBackupTime: minutesAgo(60) });
        assert.equal((await restore('r', { databaseId: source.id, targetTime: minutesAgo(90).toISOString() })).status, 400, 'before the first backup');
        assert.equal((await restore('r', { databaseId: source.id, targetTime: minutesAgo(2).toISOString() })).status, 400, 'WAL may not be archived yet');
        assert.equal((await restore('r', { databaseId: source.id, targetTime: '2026-10-17T10:30:00' })).status, 400, 'no offset');
        assert.equal((await restore('r', { databaseId: '00000000-0000-4000-8000-0000000000ff' })).status, 400, 'no such Database');

        const target = minutesAgo(30);
        const atTime = await restore('at-time', { databaseId: source.id, targetTime: target.toISOString().replace('Z', '+00:00') });
        assert.equal(atTime.status, 201);
        const restored = (await atTime.json()) as DatabaseDetails;
        assert.deepEqual(restored.restoredFrom, { databaseId: source.id, targetTime: target.toISOString() });
        const row = (await listDatabaseRows(db.pool)).find((r) => r.database.id === restored.id);
        assert.deepEqual(row?.database.restoredFrom, { databaseId: source.id, targetTime: target.toISOString() });
        assert.equal(row?.restoring, true, 'the operator renders its recovery bootstrap');

        assert.equal((await call('DELETE', `/v1/projects/${projectId}/databases/${source.id}`, 'alice')).status, 202);
        const latest = await restore('latest', { databaseId: source.id });
        assert.equal(latest.status, 201, 'a deleted source, to the latest point');
        assert.deepEqual(((await latest.json()) as DatabaseDetails).restoredFrom, { databaseId: source.id });
        assert.equal(
            (await restore('after-delete', { databaseId: source.id, targetTime: minutesAgo(1).toISOString() })).status,
            400,
            'not after the deletion',
        );

        recoveryWindows.set(`db-${source.id}`, 'connect ETIMEDOUT');
        assert.equal((await restore('later', { databaseId: source.id })).status, 503);
        assert.equal(await placeHold(db.pool, accountA, 'unpaid'), true);
        assert.equal((await restore('later', { databaseId: source.id })).status, 402, 'a Hold before the backup checks');
        assert.equal(await liftHold(db.pool, accountA, 'unpaid'), true);
        recoveryWindows.delete(`db-${source.id}`);
    });

    test("cannot restore another Project's Database", async () => {
        const other = (await (await call('POST', '/v1/projects', 'alice', { accountId: accountA, name: 'db-tests-other' })).json()) as Project;
        const foreign = (await (
            await call('POST', `/v1/projects/${other.id}/databases`, 'alice', { name: 'foreign', memoryMb: 256, storageGb: 1 })
        ).json()) as DatabaseDetails;
        recoveryWindows.set(`db-${foreign.id}`, { firstRecoverabilityPoint: new Date(0), lastSuccessfulBackupTime: new Date(0) });
        const response = await call('POST', `/v1/projects/${projectId}/databases`, 'alice', {
            name: 'stolen',
            memoryMb: 256,
            storageGb: 1,
            restoreFrom: { databaseId: foreign.id },
        });
        assert.equal(response.status, 400);
        recoveryWindows.delete(`db-${foreign.id}`);
    });

    test('deleting the Project deletes its Databases with it; nothing can be created in it afterwards', async () => {
        assert.equal((await call('DELETE', `/v1/projects/${projectId}`, 'alice')).status, 202);
        assert.equal((await call('GET', `/v1/projects/${projectId}`, 'alice')).status, 404);
        assert.ok(!(await listDatabaseRows(db.pool)).some((row) => row.project.id === projectId));
        const live = await db.pool.query('select 1 from databases where project_id = $1 and deleted_at is null', [projectId]);
        assert.equal(live.rowCount, 0);
        assert.equal(
            (await call('POST', `/v1/projects/${projectId}/databases`, 'alice', { name: 'late', memoryMb: 256, storageGb: 1 })).status,
            404,
        );
        await assert.rejects(
            db.pool.query(`insert into databases (project_id, name, memory_mb, storage_gb) values ($1, 'sneaky', 256, 1)`, [projectId]),
            /is deleted/,
        );
        assert.equal((await call('POST', '/v1/projects', 'alice', { accountId: accountA, name: 'db-tests' })).status, 201);
    });
});

describe('Database proxy: a caller\'s own role and the tunnel check', () => {
    let projectId: string;
    let database: DatabaseDetails;
    let other: DatabaseDetails;
    const proxy = (subject: string, body?: unknown, databaseId = database.id) =>
        call('POST', `/v1/projects/${projectId}/databases/${databaseId}/proxy`, subject, body);
    const withKey = (key: string, method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
        api.request(path, {
            method,
            headers: { authorization: `Bearer ${key}`, ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const tunnel = (headers: Record<string, string>, bearer?: string) =>
        api.request('/v1/database-tunnel', { headers: { ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }), ...headers } });
    const at = (databaseId: string, target = 'pooler', host = `pg-${projectId}.openupstream.test`) => ({
        'x-forwarded-host': host,
        'x-forwarded-uri': `/databases/${databaseId}/${target}`,
        'x-forwarded-method': 'GET',
    });

    before(async () => {
        const response = await call('POST', '/v1/projects', 'alice', { accountId: accountA, name: 'proxy-tests' });
        projectId = ((await response.json()) as Project).id;
        const create = async (name: string) =>
            (await (await call('POST', `/v1/projects/${projectId}/databases`, 'alice', { name, memoryMb: 256, storageGb: 1 })).json()) as DatabaseDetails;
        database = await create('orders');
        other = await create('quiet');
    });

    test('the first ask creates a read role with its password Secret; later asks return the same', async () => {
        const first = await proxy('alice');
        assert.equal(first.status, 201);
        const role = (await first.json()) as DatabaseProxy;
        assert.equal(role.access, 'read');
        assert.match(role.user, /^oup_read_[0-9a-f]{32}$/);
        assert.match(role.password, /^[A-Za-z0-9_-]{32}$/);
        assert.equal(role.database, 'app');
        assert.equal(role.tunnelUrl, `wss://pg-${projectId}.openupstream.test/databases/${database.id}/pooler`);
        const secret = appliedSecrets.filter((applied) => applied.type === 'kubernetes.io/basic-auth').at(-1);
        assert.equal(secret?.metadata.namespace, `project-${projectId}`);
        assert.equal(secret?.metadata.labels['cnpg.io/reload'], 'true');
        assert.equal(Buffer.from(secret?.data['username'] ?? '', 'base64').toString(), role.user);
        assert.equal(Buffer.from(secret?.data['password'] ?? '', 'base64').toString(), role.password);
        const again = await proxy('alice', { access: 'read' });
        assert.equal(again.status, 200);
        assert.deepEqual(await again.json(), role);
    });

    test('owner reaches the primary with a role of its own; another Member gets their own roles', async () => {
        const owner = (await (await proxy('alice', { access: 'owner' })).json()) as DatabaseProxy;
        assert.match(owner.user, /^oup_owner_/);
        assert.equal(owner.tunnelUrl, `wss://pg-${projectId}.openupstream.test/databases/${database.id}/primary`);
        const write = (await (await proxy('alice', { access: 'write' })).json()) as DatabaseProxy;
        assert.match(write.tunnelUrl, /\/pooler$/);
        const carol = (await (await proxy('carol', { access: 'owner' })).json()) as DatabaseProxy;
        assert.notEqual(carol.user, owner.user);
        assert.notEqual(carol.password, owner.password);
    });

    test('input, other Accounts and unknown Databases', async () => {
        assert.equal((await proxy('alice', { access: 'admin' })).status, 400);
        assert.equal((await proxy('bob')).status, 404);
        assert.equal((await proxy('alice', undefined, '00000000-0000-4000-8000-00000000abcd')).status, 404);
    });

    test('an API key needs openupstream:write and gets roles of its own, apart from its Member', async () => {
        const path = `/v1/projects/${projectId}/databases/${database.id}/proxy`;
        assert.equal((await withKey('madauth_alice_read_k1', 'POST', path)).status, 403);
        const created = await withKey('madauth_alice_write_k1', 'POST', path, {}, { access: 'owner' });
        assert.equal(created.status, 201);
        const key = (await created.json()) as DatabaseProxy;
        const session = (await (await proxy('alice', { access: 'owner' })).json()) as DatabaseProxy;
        assert.notEqual(key.user, session.user);
        const otherKey = (await (await withKey('madauth_alice_write_k2', 'POST', path, {}, { access: 'owner' })).json()) as DatabaseProxy;
        assert.notEqual(otherKey.user, key.user);
        assert.equal((await withKey('madauth_alice_write', 'POST', path)).status, 503);
    });

    test('the operator gets every role per Database and the tunnel host on every row of the Project', async () => {
        const rows = (await listDatabaseRows(db.pool, 'openupstream.test')).filter((row) => row.project.id === projectId);
        const orders = rows.find((row) => row.database.id === database.id);
        const quiet = rows.find((row) => row.database.id === other.id);
        assert.equal(orders?.roles?.length, 6);
        assert.deepEqual(new Set(orders?.roles?.map((role) => role.access)), new Set(['read', 'write', 'owner']));
        assert.equal(quiet?.roles, undefined);
        assert.equal(orders?.tunnelHostname, `pg-${projectId}.openupstream.test`);
        assert.equal(quiet?.tunnelHostname, `pg-${projectId}.openupstream.test`);
        const elsewhere = (await listDatabaseRows(db.pool, 'openupstream.test')).filter(
            (row) => row.project.id !== projectId && row.project.accountId === accountA,
        );
        assert.ok(elsewhere.every((row) => row.tunnelHostname === undefined));
        assert.ok((await listDatabaseRows(db.pool)).every((row) => row.tunnelHostname === undefined));
    });

    test('Traefik may open the tunnel for a Member of the Account and for a key that may write', async () => {
        assert.equal((await tunnel(at(database.id), await token('alice'))).status, 204);
        assert.equal((await tunnel(at(database.id, 'primary'), await token('carol'))).status, 204);
        assert.equal((await tunnel(at(database.id), 'madauth_alice_write_k1')).status, 204);
    });

    test('and for nobody else, nor for a host, path or method that is not a tunnel: always 403, never 404', async () => {
        assert.equal((await tunnel(at(database.id))).status, 401);
        assert.equal((await tunnel(at(database.id), 'not-a-token')).status, 401);
        assert.equal((await tunnel(at(database.id), await token('bob'))).status, 403);
        assert.equal((await tunnel(at(database.id), 'madauth_alice_read_k1')).status, 403);
        assert.equal((await tunnel(at(database.id, 'pooler', `pg-${projectId}.elsewhere.test`), await token('alice'))).status, 403);
        assert.equal((await tunnel(at(database.id, 'replica'), await token('alice'))).status, 403);
        assert.equal((await tunnel({ ...at(database.id), 'x-forwarded-uri': `/databases/${database.id}/pooler/x` }, await token('alice'))).status, 403);
        assert.equal((await tunnel({ ...at(database.id), 'x-forwarded-method': 'POST' }, await token('alice'))).status, 403);
        assert.equal((await tunnel({}, await token('alice'))).status, 403);
    });

    test('a deleted Database has no tunnel and no roles in the rows', async () => {
        assert.equal((await call('DELETE', `/v1/projects/${projectId}/databases/${other.id}`, 'alice')).status, 202);
        assert.equal((await tunnel(at(other.id), await token('alice'))).status, 403);
        assert.equal((await proxy('alice', {}, other.id)).status, 404);
    });

    test('the tunnel host names the Project: pg-<id> under the customer domain only', () => {
        const id = '0f3c2b1a-1111-4222-8333-444455556666';
        assert.equal(tunnelProjectOf(`pg-${id}.openupstream.test`, 'openupstream.test'), id);
        assert.equal(tunnelProjectOf(`PG-${id.toUpperCase()}.OpenUpstream.test`, 'openupstream.test'), id);
        assert.equal(tunnelProjectOf(`pg-${id}.x.openupstream.test`, 'openupstream.test'), undefined);
        assert.equal(tunnelProjectOf(`app-${id}.openupstream.test`, 'openupstream.test'), undefined);
        assert.equal(tunnelProjectOf('pg-abc.openupstream.test', 'openupstream.test'), undefined);
        assert.equal(tunnelProjectOf(`pg-${id}.openupstream.testx`, 'openupstream.test'), undefined);
    });
});

describe('Buckets', () => {
    let projectId: string;
    let bucket: BucketDetails;
    const path = (suffix = '') => `/v1/projects/${projectId}/buckets${suffix}`;

    before(async () => {
        const response = await call('POST', '/v1/projects', 'alice', { accountId: accountA, name: 'bucket-tests' });
        projectId = ((await response.json()) as Project).id;
    });

    test('created in a Project with its own key, usable at once at its own hostname', async () => {
        const response = await call('POST', path(), 'alice', { name: 'shop-assets' });
        assert.equal(response.status, 201);
        bucket = (await response.json()) as BucketDetails;
        const garage = storage.buckets.get('shop-assets');
        assert.ok(garage !== undefined);
        assert.deepEqual(bucket.access, {
            endpoint: 'https://shop-assets.s3.openupstream.test',
            region: 'garage',
            accessKeyId: garage.accessKeyId,
            secretAccessKey: `secret-of-${garage.accessKeyId}`,
        });
        assert.equal(response.headers.get('location'), path(`/${bucket.id}`));
        assert.deepEqual(await (await call('GET', path(`/${bucket.id}`), 'alice')).json(), bucket);
    });

    test('the list leaves out keys and Garage ids', async () => {
        const listed = (await (await call('GET', path(), 'alice')).json()) as Bucket[];
        assert.deepEqual(listed, [{ id: bucket.id, projectId, name: 'shop-assets', createdAt: bucket.createdAt }]);
    });

    test('names are hostname labels and unique across all Projects', async () => {
        const post = (name: string, subject = 'alice') => call('POST', path(), subject, { name });
        for (const name of ['ab', 'Shop', '-shop', 'shop-', 'shop.assets', 'a'.repeat(64)]) {
            assert.equal((await post(name)).status, 400, name);
        }
        assert.equal((await post('shop-assets')).status, 409);
        const theirs = (await (await call('POST', '/v1/projects', 'bob', { accountId: accountB, name: 'theirs' })).json()) as Project;
        const taken = await call('POST', `/v1/projects/${theirs.id}/buckets`, 'bob', { name: 'shop-assets' });
        assert.equal(taken.status, 409);
        assert.deepEqual(await taken.json(), { error: 'the Bucket name shop-assets is taken' });
    });

    test('Garage down: 503 when creating or showing the key, and no row', async () => {
        storage.down = true;
        assert.equal((await call('POST', path(), 'alice', { name: 'offline' })).status, 503);
        assert.equal((await call('GET', path(`/${bucket.id}`), 'alice')).status, 503);
        storage.down = false;
        assert.equal((await db.pool.query(`select 1 from buckets where name = 'offline'`)).rowCount, 0);
    });

    test("another Account's Member finds nothing", async () => {
        assert.equal((await call('GET', path(), 'bob')).status, 404);
        assert.equal((await call('GET', path(`/${bucket.id}`), 'bob')).status, 404);
        assert.equal((await call('DELETE', path(`/${bucket.id}`), 'bob')).status, 404);
    });

    test('an API key with only openupstream:read sees the key id, not its secret', async () => {
        const read = await api.request(path(`/${bucket.id}`), { headers: { authorization: 'Bearer madauth_alice_read' } });
        assert.equal(read.status, 200);
        assert.deepEqual(((await read.json()) as BucketDetails).access, {
            endpoint: bucket.access.endpoint,
            region: 'garage',
            accessKeyId: bucket.access.accessKeyId,
        });
    });

    test('deleted: gone from the API at once, its key revoked; the name stays taken until the cleanup removed it', async () => {
        assert.equal((await call('DELETE', path(`/${bucket.id}`), 'alice')).status, 202);
        assert.ok(storage.deletedKeys.includes(bucket.access.accessKeyId));
        assert.equal((await call('GET', path(`/${bucket.id}`), 'alice')).status, 404);
        assert.equal((await call('DELETE', path(`/${bucket.id}`), 'alice')).status, 404);
        assert.deepEqual(await (await call('GET', path(), 'alice')).json(), []);
        assert.equal((await call('POST', path(), 'alice', { name: 'shop-assets' })).status, 409);
    });

    test('deleting the Project deletes its Buckets with it', async () => {
        assert.equal((await call('POST', path(), 'alice', { name: 'shop-media' })).status, 201);
        assert.equal((await call('DELETE', `/v1/projects/${projectId}`, 'alice')).status, 202);
        const live = await db.pool.query('select 1 from buckets where project_id = $1 and deleted_at is null', [projectId]);
        assert.equal(live.rowCount, 0);
        assert.equal((await call('POST', path(), 'alice', { name: 'shop-late' })).status, 404);
        await assert.rejects(
            db.pool.query(`insert into buckets (project_id, name, garage_bucket_id, access_key_id) values ($1, 'sneaky', 'b', 'GK')`, [projectId]),
            /is deleted/,
        );
    });
});

describe('Routing', () => {
    let projectId: string;
    let domain: Domain;
    let site: BucketDetails;
    let docs: BucketDetails;
    const routes = (suffix = '') => `/v1/projects/${projectId}/domains/${domain.id}/routes${suffix}`;
    const newBucket = async (name: string) =>
        (await (await call('POST', `/v1/projects/${projectId}/buckets`, 'alice', { name })).json()) as BucketDetails;
    const garageId = (bucket: BucketDetails) => storage.buckets.get(bucket.name)?.bucketId ?? '';

    before(async () => {
        const response = await call('POST', '/v1/projects', 'alice', { accountId: accountA, name: 'site' });
        projectId = ((await response.json()) as Project).id;
        site = await newBucket('alice-site');
        docs = await newBucket('alice-docs');
    });

    test('a new Project has its default Domain, <name>-<random> under the customer domain', async () => {
        const domains = (await (await call('GET', `/v1/projects/${projectId}/domains`, 'alice')).json()) as Domain[];
        assert.equal(domains.length, 1);
        domain = domains[0] as Domain;
        assert.equal(domain.kind, 'default');
        assert.match(domain.hostname, /^site-[a-z0-9]{8}\.openupstream\.test$/);
        assert.equal((await call('GET', `/v1/projects/${projectId}/domains`, 'bob')).status, 404);
    });

    test('a Route serves a Bucket at a path prefix; Garage serves it as a website, with SPA fallback if asked', async () => {
        const response = await call('POST', routes(), 'alice', { pathPrefix: '/', bucketId: site.id, spaFallback: true });
        assert.equal(response.status, 201);
        const route = (await response.json()) as Route;
        assert.deepEqual(route.target, { kind: 'bucket', bucketId: site.id, spaFallback: true });
        assert.equal(storage.websites.get(garageId(site)), true);
        assert.equal((await call('POST', routes(), 'alice', { pathPrefix: '/docs', bucketId: docs.id })).status, 201);
        assert.equal(storage.websites.get(garageId(docs)), false);
        const listed = (await (await call('GET', routes(), 'alice')).json()) as Route[];
        assert.deepEqual(listed.map((r) => r.pathPrefix), ['/docs', '/']);
    });

    test('the Routes operator sees the Domain with its Routes, longest prefix first', async () => {
        const routing = (await listDomainRoutings(db.pool)).find((d) => d.domainId === domain.id);
        assert.deepEqual(routing, {
            projectId,
            projectName: 'site',
            domainId: domain.id,
            hostname: domain.hostname,
            kind: 'default',
            routes: [
                { id: routing?.routes[0]?.id, pathPrefix: '/docs', kind: 'bucket', bucketId: docs.id, bucketName: 'alice-docs', spaFallback: false },
                { id: routing?.routes[1]?.id, pathPrefix: '/', kind: 'bucket', bucketId: site.id, bucketName: 'alice-site', spaFallback: true },
            ],
        });
    });

    test('input is checked: prefixes, duplicates, the Bucket, SPA fallback per Bucket', async () => {
        const post = (body: unknown) => call('POST', routes(), 'alice', body);
        for (const pathPrefix of ['', 'docs', '/docs/', '/a b', '//x']) {
            assert.equal((await post({ pathPrefix, bucketId: site.id })).status, 400, pathPrefix);
        }
        assert.equal((await post({ pathPrefix: '/docs', bucketId: site.id, spaFallback: true })).status, 409);
        const conflict = await post({ pathPrefix: '/app', bucketId: site.id, spaFallback: false });
        assert.equal(conflict.status, 409);
        assert.match(((await conflict.json()) as { error: string }).error, /spaFallback true/);
        const theirs = (await (await call('POST', '/v1/projects', 'bob', { accountId: accountB, name: 'bobs' })).json()) as Project;
        const theirBucket = (await (await call('POST', `/v1/projects/${theirs.id}/buckets`, 'bob', { name: 'bob-site' })).json()) as BucketDetails;
        assert.equal((await post({ pathPrefix: '/bob', bucketId: theirBucket.id })).status, 400);
        assert.equal((await call('POST', routes(), 'bob', { pathPrefix: '/x', bucketId: site.id })).status, 404);
    });

    test('Garage down: 503 and no Route', async () => {
        storage.down = true;
        assert.equal((await call('POST', routes(), 'alice', { pathPrefix: '/later', bucketId: docs.id })).status, 503);
        storage.down = false;
        const listed = (await (await call('GET', routes(), 'alice')).json()) as Route[];
        assert.ok(!listed.some((r) => r.pathPrefix === '/later'));
    });

    test('a routed Bucket cannot be deleted; deleting its last Route stops Garage serving it', async () => {
        assert.equal((await call('DELETE', `/v1/projects/${projectId}/buckets/${docs.id}`, 'alice')).status, 409);
        const docsRoute = ((await (await call('GET', routes(), 'alice')).json()) as Route[]).find((r) => r.pathPrefix === '/docs');
        assert.equal((await call('DELETE', routes(`/${docsRoute?.id}`), 'bob')).status, 404);
        assert.equal((await call('DELETE', routes(`/${docsRoute?.id}`), 'alice')).status, 204);
        assert.equal((await call('DELETE', routes(`/${docsRoute?.id}`), 'alice')).status, 404);
        assert.equal(storage.websites.has(garageId(docs)), false);
        assert.equal(storage.websites.get(garageId(site)), true);
        assert.equal((await call('DELETE', `/v1/projects/${projectId}/buckets/${docs.id}`, 'alice')).status, 202);
    });

    test('deleting the Project removes its Domains and Routes at once', async () => {
        assert.equal((await call('DELETE', `/v1/projects/${projectId}`, 'alice')).status, 202);
        assert.ok(!(await listDomainRoutings(db.pool)).some((d) => d.domainId === domain.id));
        assert.equal((await db.pool.query('select 1 from domains where project_id = $1', [projectId])).rowCount, 0);
    });

    test('Projects from before default Domains get one at startup', async () => {
        const { rows } = await db.pool.query<{ id: string }>(
            `insert into projects (account_id, name) values ($1, 'older') returning id`,
            [accountA],
        );
        assert.ok((await ensureDefaultDomains(db.pool, 'openupstream.test')) >= 1);
        assert.equal(await ensureDefaultDomains(db.pool, 'openupstream.test'), 0);
        const domains = (await (await call('GET', `/v1/projects/${rows[0]?.id}/domains`, 'alice')).json()) as Domain[];
        assert.match(domains[0]?.hostname ?? '', /^older-[a-z0-9]{8}\.openupstream\.test$/);
    });
});

describe('Custom domains', () => {
    let projectId: string;
    let otherProjectId: string;
    let site: BucketDetails;
    const domains = (pid: string, suffix = '') => `/v1/projects/${pid}/domains${suffix}`;
    const claim = async (pid: string, hostname: string, subject = 'alice') => call('POST', domains(pid), subject, { hostname });
    const pending = (domain: Domain) => {
        assert.ok(domain.kind === 'custom' && domain.verification.state === 'pending');
        return domain.verification.txtRecord;
    };

    before(async () => {
        projectId = ((await (await call('POST', '/v1/projects', 'alice', { accountId: accountA, name: 'shop' })).json()) as Project).id;
        otherProjectId = ((await (await call('POST', '/v1/projects', 'bob', { accountId: accountB, name: 'squat' })).json()) as Project).id;
        site = (await (await call('POST', `/v1/projects/${projectId}/buckets`, 'alice', { name: 'alice-shop' })).json()) as BucketDetails;
    });

    test('a claim is pending, with the TXT record that proves it; hostnames are normalized and checked', async () => {
        const response = await claim(projectId, 'WWW.Shop.Example.');
        assert.equal(response.status, 201);
        const domain = (await response.json()) as Domain;
        assert.equal(domain.hostname, 'www.shop.example');
        const record = pending(domain);
        assert.equal(record.name, '_openupstream.www.shop.example');
        assert.ok(record.value.length >= 32);
        assert.equal(response.headers.get('location'), domains(projectId, `/${domain.id}`));
        for (const hostname of ['localhost', 'a..example', '-a.example', 'a_b.example', `${'a'.repeat(64)}.example`, 'shop.example/x']) {
            assert.equal((await claim(projectId, hostname)).status, 400, hostname);
        }
        for (const hostname of ['openupstream.test', 'x.openupstream.test', 'api.platform.test', 'welcome.test', 'www.welcome.test']) {
            assert.equal((await claim(projectId, hostname)).status, 400, hostname);
        }
        assert.equal((await claim(projectId, 'www.shop.example')).status, 409);
        assert.equal((await claim(projectId, 'www.shop.example', 'bob')).status, 404);
    });

    test("the website's Project may claim the waitlist's host, and nothing else of ours; the claim still needs its proof", async () => {
        const withWebsite = createApi({ ...apiDeps, websiteProjectId: projectId });
        const claimThere = async (pid: string, hostname: string) =>
            withWebsite.request(domains(pid), {
                method: 'POST',
                headers: { authorization: `Bearer ${await token('alice')}`, 'content-type': 'application/json' },
                body: JSON.stringify({ hostname }),
            });
        for (const hostname of ['www.welcome.test', 'openupstream.test', 'api.platform.test']) {
            assert.equal((await claimThere(projectId, hostname)).status, 400, hostname);
        }
        const other = await call('POST', '/v1/projects', 'alice', { accountId: accountA, name: 'not-the-website' });
        assert.equal((await claimThere(((await other.json()) as Project).id, 'welcome.test')).status, 400);
        const response = await claimThere(projectId, 'welcome.test');
        assert.equal(response.status, 201);
        assert.equal(pending((await response.json()) as Domain).name, '_openupstream.welcome.test');
    });

    test('verifying looks the TXT record up now; the first claim verified gets the hostname', async () => {
        const [mine] = ((await (await call('GET', domains(projectId), 'alice')).json()) as Domain[]).filter((d) => d.kind === 'custom');
        assert.ok(mine !== undefined);
        // Another Account claims it too: a pending claim reserves nothing.
        const theirs = (await (await claim(otherProjectId, 'www.shop.example', 'bob')).json()) as Domain;
        const verify = (pid: string, id: string, subject = 'alice') => call('POST', domains(pid, `/${id}/verify`), subject);

        const missing = await verify(projectId, mine.id);
        assert.equal(missing.status, 409);
        assert.deepEqual(((await missing.json()) as { found: string[] }).found, []);
        dnsDown = true;
        assert.equal((await verify(projectId, mine.id)).status, 503);
        dnsDown = false;

        txt.set(pending(mine).name, ['v=spf1 -all', pending(mine).value]);
        const verified = await verify(projectId, mine.id);
        assert.equal(verified.status, 200);
        const domain = (await verified.json()) as Domain;
        assert.ok(domain.kind === 'custom' && domain.verification.state === 'verified');
        // Once verified it stays so, whatever DNS says later.
        txt.delete(pending(mine).name);
        assert.equal((await verify(projectId, mine.id)).status, 200);

        // Bob cannot verify his claim even with his token published, nor claim the hostname anew.
        txt.set(pending(theirs).name, [pending(theirs).value]);
        assert.equal((await verify(otherProjectId, theirs.id, 'bob')).status, 409);
        assert.equal((await claim(otherProjectId, 'shop.example', 'bob')).status, 201);
        assert.equal((await claim(otherProjectId, 'www.shop.example', 'bob')).status, 409);
        assert.equal((await verify(projectId, theirs.id)).status, 404);
    });

    test('a verified custom domain is routed like the default one, with its own kind', async () => {
        const [mine] = ((await (await call('GET', domains(projectId), 'alice')).json()) as Domain[]).filter((d) => d.kind === 'custom');
        assert.ok(mine !== undefined);
        assert.equal((await call('POST', domains(projectId, `/${mine.id}/routes`), 'alice', { pathPrefix: '/', bucketId: site.id })).status, 201);
        const routing = (await listDomainRoutings(db.pool)).find((d) => d.domainId === mine.id);
        assert.equal(routing?.hostname, 'www.shop.example');
        assert.equal(routing?.kind, 'custom');
        // A pending claim is never routed.
        const [theirs] = ((await (await call('GET', domains(otherProjectId), 'bob')).json()) as Domain[]).filter((d) => d.kind === 'custom');
        assert.ok(!(await listDomainRoutings(db.pool)).some((d) => d.domainId === theirs?.id));
    });

    test('deleting a custom domain deletes its Routes and stops Garage serving a Bucket left without one; the default Domain stays', async () => {
        const all = (await (await call('GET', domains(projectId), 'alice')).json()) as Domain[];
        const mine = all.find((d) => d.kind === 'custom');
        const defaultDomain = all.find((d) => d.kind === 'default');
        assert.ok(mine !== undefined && defaultDomain !== undefined);
        assert.equal(storage.websites.has(storage.buckets.get('alice-shop')?.bucketId ?? ''), true);
        assert.equal((await call('DELETE', domains(projectId, `/${defaultDomain.id}`), 'alice')).status, 409);
        assert.equal((await call('DELETE', domains(projectId, `/${mine.id}`), 'bob')).status, 404);
        assert.equal((await call('DELETE', domains(projectId, `/${mine.id}`), 'alice')).status, 204);
        assert.equal((await call('DELETE', domains(projectId, `/${mine.id}`), 'alice')).status, 404);
        assert.equal(storage.websites.has(storage.buckets.get('alice-shop')?.bucketId ?? ''), false);
        assert.equal((await db.pool.query('select 1 from routes where domain_id = $1', [mine.id])).rowCount, 0);
        // The hostname is free again: Bob's claim can be verified now.
        const [theirs] = ((await (await call('GET', domains(otherProjectId), 'bob')).json()) as Domain[]).filter(
            (d) => d.hostname === 'www.shop.example',
        );
        assert.equal((await call('POST', domains(otherProjectId, `/${theirs?.id}/verify`), 'bob')).status, 200);
    });
});

describe('Secrets', () => {
    let projectId: string;
    const path = (name = '') => `/v1/projects/${projectId}/secrets${name === '' ? '' : `/${name}`}`;
    const latest = () => appliedSecrets.filter((secret) => secret.metadata.name === 'project-secrets').at(-1);
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    /** The API writes the Kubernetes Secret in the background: retries `check` for up to a second. */
    const eventually = async (check: () => void) => {
        for (let attempt = 0; ; attempt++) {
            const failed = (() => {
                try {
                    check();
                    return undefined;
                } catch (error) {
                    return error;
                }
            })();
            if (failed === undefined) {
                return;
            }
            if (attempt >= 50) {
                throw failed;
            }
            await pause(20);
        }
    };
    const decoded = (secret: SecretManifest | undefined) =>
        Object.fromEntries(Object.entries(secret?.data ?? {}).map(([name, value]) => [name, Buffer.from(value, 'base64').toString('utf8')]));

    before(async () => {
        const response = await call('POST', '/v1/projects', 'alice', { accountId: accountA, name: 'secret-tests' });
        projectId = ((await response.json()) as Project).id;
    });

    test("created with PUT, and written into the Project's Kubernetes Secret at once", async () => {
        const created = await call('PUT', path('API_TOKEN'), 'alice', { value: 's3cr3t ✓' });
        assert.equal(created.status, 201);
        const secret = (await created.json()) as Secret;
        assert.equal(secret.name, 'API_TOKEN');
        assert.ok(!('value' in secret));
        await eventually(() => assert.deepEqual(decoded(latest()), { API_TOKEN: 's3cr3t ✓' }));
        assert.equal(latest()?.metadata.name, 'project-secrets');
        assert.equal(latest()?.metadata.namespace, `project-${projectId}`);
    });

    test('a second PUT replaces the value: 200; the list has names only', async () => {
        assert.equal((await call('PUT', path('API_TOKEN'), 'alice', { value: 'rotated' })).status, 200);
        assert.equal((await call('PUT', path('DATABASE_URL'), 'alice', { value: 'postgres://x' })).status, 201);
        await eventually(() => assert.deepEqual(decoded(latest()), { API_TOKEN: 'rotated', DATABASE_URL: 'postgres://x' }));
        const listed = (await (await call('GET', path(), 'alice')).json()) as Secret[];
        assert.deepEqual(listed.map((s) => s.name), ['API_TOKEN', 'DATABASE_URL']);
        assert.ok(listed.every((s) => !('value' in s)));
    });

    test('a name that is no environment variable name, or a value too large: 400', async () => {
        assert.equal((await call('PUT', path('1ABC'), 'alice', { value: 'x' })).status, 400);
        assert.equal((await call('PUT', path('A-B'), 'alice', { value: 'x' })).status, 400);
        assert.equal((await call('PUT', path('BIG'), 'alice', { value: 'x'.repeat(64 * 1024 + 1) })).status, 400);
        assert.equal((await call('PUT', path('NO_VALUE'), 'alice', {})).status, 400);
    });

    test("all of a Project's values together are limited", async () => {
        for (const n of [1, 2, 3, 4, 5, 6, 7]) {
            assert.equal((await call('PUT', path(`CHUNK_${n}`), 'alice', { value: 'x'.repeat(64 * 1024) })).status, 201);
        }
        const refused = await call('PUT', path('CHUNK_8'), 'alice', { value: 'x'.repeat(64 * 1024) });
        assert.equal(refused.status, 400);
        // Replacing a value counts the new one instead of the old.
        assert.equal((await call('PUT', path('CHUNK_7'), 'alice', { value: 'small' })).status, 200);
        for (const n of [1, 2, 3, 4, 5, 6, 7]) {
            assert.equal((await call('DELETE', path(`CHUNK_${n}`), 'alice')).status, 204);
        }
    });

    test('DELETE removes the value from the Kubernetes Secret; an unknown name: 404', async () => {
        assert.equal((await call('DELETE', path('DATABASE_URL'), 'alice')).status, 204);
        await eventually(() => assert.deepEqual(decoded(latest()), { API_TOKEN: 'rotated' }));
        assert.equal((await call('DELETE', path('DATABASE_URL'), 'alice')).status, 404);
    });

    test('before the Project has a namespace the value is stored all the same', async () => {
        await pause(200); // the earlier tests' writes
        missingNamespaces.add(`project-${projectId}`);
        const before = appliedSecrets.length;
        assert.equal((await call('PUT', path('LATER'), 'alice', { value: 'v' })).status, 201);
        await pause(200);
        assert.equal(appliedSecrets.length, before);
        missingNamespaces.delete(`project-${projectId}`);
    });

    test('quick changes are written in order, so the last write has the newest value; one write waits for them all', async () => {
        const created = await call('POST', '/v1/projects', 'alice', { accountId: accountA, name: 'secret-order' });
        const orderProject = ((await created.json()) as Project).id;
        const order = `/v1/projects/${orderProject}/secrets/ORDER`;
        const writes = () => appliedSecrets.filter((s) => s.metadata.name === 'project-secrets' && s.metadata.namespace === `project-${orderProject}`);
        const written = () => decoded(writes().at(-1));
        let reached = () => {};
        let release = () => {};
        const blocked = new Promise<void>((resolve) => (reached = resolve));
        secretHold = { namespace: `project-${orderProject}`, reached, released: new Promise<void>((resolve) => (release = resolve)) };

        assert.equal((await call('PUT', order, 'alice', { value: 'first' })).status, 201);
        await blocked; // the first write has read 'first' and waits to land
        assert.equal((await call('PUT', order, 'alice', { value: 'second' })).status, 200);
        assert.equal((await call('PUT', order, 'alice', { value: 'third' })).status, 200);
        await pause(100);
        release();
        await eventually(() => assert.deepEqual(written(), { ORDER: 'third' }));
        await pause(100);
        assert.deepEqual(written(), { ORDER: 'third' });
        assert.equal(writes().length, 2);
    });

    test("another Account's Project: 404; a read-only key lists but cannot write", async () => {
        assert.equal((await call('GET', path(), 'bob')).status, 404);
        assert.equal((await call('PUT', path('X'), 'bob', { value: 'v' })).status, 404);
        const read = { authorization: 'Bearer madauth_alice_read', 'content-type': 'application/json' };
        assert.equal((await api.request(path(), { headers: read })).status, 200);
        assert.equal((await api.request(path('X'), { method: 'PUT', headers: read, body: '{"value":"v"}' })).status, 403);
    });
});

describe('Services', () => {
    let projectId: string;
    let service: ServiceDetails;
    const digest = (c: string) => `sha256:${c.repeat(64)}`;
    const path = (rest = '') => `/v1/projects/${projectId}/services${rest}`;
    const input = { name: 'api', image: 'ghcr.io/acme/api:v1', port: 8080, memoryMb: 256, cpuMillicores: 250 };

    before(async () => {
        const response = await call('POST', '/v1/projects', 'alice', { accountId: accountA, name: 'service-tests' });
        projectId = ((await response.json()) as Project).id;
        images.set('acme/api:v1', digest('1'));
        images.set('acme/private:v1', digest('2'));
        images.set('library/nginx:latest', digest('3'));
    });

    test('created with its tag pinned to the digest the registry has now; deploying', async () => {
        const response = await call('POST', path(), 'alice', input);
        assert.equal(response.status, 201);
        service = (await response.json()) as ServiceDetails;
        assert.equal(service.imageDigest, digest('1'));
        assert.equal(service.replicas, 1);
        assert.equal(service.homeSite, null);
        assert.equal(service.registryAuth, false);
        assert.equal(service.state, 'deploying');
    });

    test("the state is read from the Deployment, and is deploying until it carries the row's current spec", async () => {
        const stateNow = async () => ((await (await call('GET', path(`/${service.id}`), 'alice')).json()) as ServiceDetails).state;
        const row = (await listServiceRows(db.pool, projectId)).find((candidate) => candidate.service.id === service.id);
        assert.ok(row);
        const status = { replicas: 1, generation: 1, observedGeneration: 1, updatedReplicas: 1, availableReplicas: 1, specVersion: serviceSpecVersion(row) };
        deployments.set(`svc-${service.id}`, status);
        assert.equal(await stateNow(), 'running');
        deployments.set(`svc-${service.id}`, { ...status, replicas: 2, updatedReplicas: 2 });
        assert.equal(await stateNow(), 'degraded');
        // A change the operator has not applied yet: the old Deployment is fully available, but not what was asked for.
        deployments.set(`svc-${service.id}`, { ...status, specVersion: 'an older spec' });
        assert.equal(await stateNow(), 'deploying');
        const listed = (await (await call('GET', path(), 'alice')).json()) as ServiceDetails[];
        assert.equal(listed.find((candidate) => candidate.id === service.id)?.state, 'deploying');
        deployments.delete(`svc-${service.id}`);
    });

    test('an image the registry does not have, or a malformed one: 400; a registry that is down: 503', async () => {
        assert.equal((await call('POST', path(), 'alice', { ...input, name: 'gone', image: 'ghcr.io/acme/api:v9' })).status, 400);
        assert.equal((await call('POST', path(), 'alice', { ...input, name: 'bad', image: 'ghcr.io/Acme/API' })).status, 400);
        registryDown = true;
        assert.equal((await call('POST', path(), 'alice', { ...input, name: 'down' })).status, 503);
        registryDown = false;
        assert.equal((await call('POST', path(), 'alice', { ...input, name: 'api' })).status, 409);
    });

    test('a private image needs registryAuth; it is stored sealed and never returned', async () => {
        const image = 'ghcr.io/acme/private:v1';
        assert.equal((await call('POST', path(), 'alice', { ...input, name: 'private', image })).status, 400);
        const created = await call('POST', path(), 'alice', {
            ...input,
            name: 'private',
            image,
            registryAuth: { username: 'ci', password: 'token' },
        });
        assert.equal(created.status, 201);
        const body = (await created.json()) as ServiceDetails & { password?: unknown };
        assert.equal(body.registryAuth, true);
        assert.equal(body.imageDigest, digest('2'));
        assert.ok(!JSON.stringify(body).includes('token'));
        const stored = await db.pool.query<{ registry_auth: Buffer }>('select registry_auth from services where id = $1', [body.id]);
        assert.ok(!stored.rows[0]?.registry_auth.toString('latin1').includes('token'));
    });

    test('a new image at another registry drops the stored credentials instead of sending them there', async () => {
        const created = (await (
            await call('POST', path(), 'alice', { ...input, name: 'moving', image: 'ghcr.io/acme/private:v1', registryAuth: { username: 'ci', password: 'token' } })
        ).json()) as ServiceDetails;
        const moved = await call('PATCH', path(`/${created.id}`), 'alice', { image: 'nginx' });
        assert.equal(moved.status, 200);
        const body = (await moved.json()) as ServiceDetails;
        assert.equal(body.registryAuth, false);
        assert.equal(body.imageDigest, digest('3'));
        assert.equal((await call('DELETE', path(`/${created.id}`), 'alice')).status, 202);
    });

    test('logs: the replicas\' last lines as NDJSON, found by the Service\'s label; checked like the Service', async () => {
        pods.set(`project-${projectId} openupstream.io/service-id=${service.id}`, [
            { name: 'svc-a', nodeName: 'node-1', containers: [{ name: 'app', state: 'running', restartCount: 0 }] },
        ]);
        podLogs.set('svc-a/app', ['2026-11-09T10:00:00Z one', '2026-11-09T10:00:01Z two', '2026-11-09T10:00:02Z three']);
        const response = await call('GET', path(`/${service.id}/logs?tail=2`), 'alice');
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type') ?? '', /^application\/x-ndjson/);
        const entries = (await response.text())
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as LogEntry);
        assert.deepEqual(entries, [
            { pod: 'svc-a', site: 'hetzner-fsn1', time: '2026-11-09T10:00:01Z', line: 'two', previous: false },
            { pod: 'svc-a', site: 'hetzner-fsn1', time: '2026-11-09T10:00:02Z', line: 'three', previous: false },
        ]);
        assert.equal((await call('GET', path(`/${service.id}/logs`), 'bob')).status, 404);
        assert.equal((await call('GET', path(`/${service.id}/logs?tail=-1`), 'alice')).status, 400);
        assert.equal((await call('GET', path(`/${service.id}/logs?follow=yes`), 'alice')).status, 400);
        assert.equal((await call('GET', path(`/${service.id}/logs?tail=`), 'alice')).status, 400, 'an empty tail is not 0');
        assert.equal((await call('GET', path(`/${service.id}/logs?tail=10001`), 'alice')).status, 400);
        kubeDown = true;
        assert.equal((await call('GET', path(`/${service.id}/logs`), 'alice')).status, 503);
        kubeDown = false;
    });

    test('logs with follow: at most 10 at once per Account; one that ends frees its place', async () => {
        const followed = path(`/${service.id}/logs?follow=true`);
        const clients = Array.from({ length: 10 }, () => new AbortController());
        const open = await Promise.all(
            clients.map(async (client) =>
                api.request(followed, { headers: { authorization: `Bearer ${await token('alice')}` }, signal: client.signal }),
            ),
        );
        assert.deepEqual(
            open.map((response) => response.status),
            Array(10).fill(200),
        );
        const refused = await call('GET', followed, 'alice');
        assert.equal(refused.status, 429);
        assert.equal((await call('GET', path(`/${service.id}/logs`), 'alice')).status, 200, 'without follow there is no limit');
        clients.forEach((client) => client.abort());
        await Promise.all(open.map((response) => response.body?.cancel()));
        let again = await call('GET', followed, 'alice');
        for (let attempt = 0; attempt < 50 && again.status === 429; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
            again = await call('GET', followed, 'alice');
        }
        assert.equal(again.status, 200);
        await again.body?.cancel();
    });

    test('logs with follow: ends once no pod is left to write', async () => {
        pods.set(`project-${projectId} openupstream.io/service-id=${service.id}`, []);
        const response = await call('GET', path(`/${service.id}/logs?follow=true`), 'alice');
        assert.equal(response.status, 200);
        assert.equal(await response.text(), '');
    });

    test('PATCH: a new tag is resolved again; replicas alone are not', async () => {
        images.set('acme/api:v2', digest('4'));
        const patched = await call('PATCH', path(`/${service.id}`), 'alice', { image: 'ghcr.io/acme/api:v2', replicas: 2 });
        assert.equal(patched.status, 200);
        const body = (await patched.json()) as ServiceDetails;
        assert.equal(body.imageDigest, digest('4'));
        assert.equal(body.replicas, 2);
        images.set('acme/api:v2', digest('5'));
        const scaled = (await (await call('PATCH', path(`/${service.id}`), 'alice', { replicas: 3 })).json()) as ServiceDetails;
        assert.equal(scaled.imageDigest, digest('4'));
        assert.equal((await call('PATCH', path(`/${service.id}`), 'alice', { replicas: 11 })).status, 400);
    });

    test('deploy resolves the same tag again and pins its new digest', async () => {
        const deployed = await call('POST', path(`/${service.id}/deploy`), 'alice');
        assert.equal(deployed.status, 200);
        const body = (await deployed.json()) as ServiceDetails;
        assert.equal(body.imageDigest, digest('5'));
        assert.ok(body.deployedAt > service.deployedAt);
    });

    test('the operators get the pinned image, the site and a version of the Secrets', async () => {
        const rows = (await listServiceRows(db.pool)).filter((row: ServiceRow) => row.project.id === projectId);
        const api = rows.find((row) => row.service.name === 'api');
        assert.equal(api?.pinnedImage, `ghcr.io/acme/api@${digest('5')}`);
        assert.equal(api?.site, 'hetzner-fsn1');
        const before = api?.secretsVersion;
        assert.equal((await call('PUT', `/v1/projects/${projectId}/secrets/TOKEN`, 'alice', { value: 'x' })).status, 201);
        // The version moves once the new values are in the cluster, which the API writes right after answering.
        const versionNow = async () => (await listServiceRows(db.pool)).find((row) => row.service.id === service.id)?.secretsVersion;
        for (let attempt = 0; attempt < 50 && (await versionNow()) === before; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.notEqual(await versionNow(), before);
    });

    test('a single replica runs where the Project\'s oldest Database is, unless homeSite says otherwise', async () => {
        assert.equal((await call('POST', `/v1/projects/${projectId}/databases`, 'alice', { name: 'main', homeSite: 'ovh-lim', memoryMb: 256, storageGb: 1 })).status, 201);
        const site = async () => (await listServiceRows(db.pool)).find((row) => row.service.id === service.id)?.site;
        assert.equal(await site(), 'ovh-lim');
        assert.equal((await call('PATCH', path(`/${service.id}`), 'alice', { homeSite: 'hetzner-fsn1' })).status, 200);
        assert.equal(await site(), 'hetzner-fsn1');
    });

    test("the Service's row names the Project's live Databases, oldest first", async () => {
        const created = await call('POST', `/v1/projects/${projectId}/databases`, 'alice', { name: 'events-db', memoryMb: 256, storageGb: 1 });
        const second = (await created.json()) as { id: string };
        const databases = async () => (await listServiceRows(db.pool)).find((row) => row.service.id === service.id)?.databases.map((d) => d.name);
        assert.deepEqual(await databases(), ['main', 'events-db']);
        assert.equal((await call('DELETE', `/v1/projects/${projectId}/databases/${second.id}`, 'alice')).status, 202);
        assert.deepEqual(await databases(), ['main']);
    });

    test('a Route sends a prefix to the Service, which cannot be deleted while it does', async () => {
        const [domain] = (await (await call('GET', `/v1/projects/${projectId}/domains`, 'alice')).json()) as Domain[];
        assert.ok(domain);
        const routes = `/v1/projects/${projectId}/domains/${domain.id}/routes`;
        const created = await call('POST', routes, 'alice', { pathPrefix: '/api', serviceId: service.id });
        assert.equal(created.status, 201);
        const route = (await created.json()) as Route;
        assert.deepEqual(route.target, { kind: 'service', serviceId: service.id });
        const routing = (await listDomainRoutings(db.pool)).find((d) => d.domainId === domain.id);
        assert.deepEqual(routing?.routes, [{ id: route.id, pathPrefix: '/api', kind: 'service', serviceId: service.id, port: 8080 }]);
        assert.equal((await call('POST', routes, 'alice', { pathPrefix: '/x', serviceId: service.id, spaFallback: true })).status, 400);
        assert.equal((await call('POST', routes, 'alice', { pathPrefix: '/x', serviceId: '00000000-0000-4000-8000-000000000099' })).status, 400);
        assert.equal((await call('DELETE', path(`/${service.id}`), 'alice')).status, 409);
        assert.equal((await call('PATCH', path(`/${service.id}`), 'alice', { port: null })).status, 409, 'a routed Service keeps its port');
        assert.equal((await call('DELETE', `${routes}/${route.id}`, 'alice')).status, 204);
    });

    test('a worker has no port, and no Route can serve it until it gets one', async () => {
        const { port: _port, ...withoutPort } = input;
        const created = await call('POST', path(), 'alice', { ...withoutPort, name: 'worker' });
        assert.equal(created.status, 201);
        const worker = (await created.json()) as ServiceDetails;
        assert.equal(worker.port, null);
        const [domain] = (await (await call('GET', `/v1/projects/${projectId}/domains`, 'alice')).json()) as Domain[];
        assert.ok(domain);
        const routes = `/v1/projects/${projectId}/domains/${domain.id}/routes`;
        assert.equal((await call('POST', routes, 'alice', { pathPrefix: '/jobs', serviceId: worker.id })).status, 409);
        assert.equal((await call('PATCH', path(`/${worker.id}`), 'alice', { port: 9000 })).status, 200);
        const route = await call('POST', routes, 'alice', { pathPrefix: '/jobs', serviceId: worker.id });
        assert.equal(route.status, 201);
        assert.equal((await call('DELETE', `${routes}/${((await route.json()) as Route).id}`, 'alice')).status, 204);
        const removed = await call('PATCH', path(`/${worker.id}`), 'alice', { port: null });
        assert.equal(((await removed.json()) as ServiceDetails).port, null);
        assert.equal((await call('DELETE', path(`/${worker.id}`), 'alice')).status, 202);
    });

    test("another Account's Project: 404; deleted: 202, then gone", async () => {
        assert.equal((await call('GET', path(`/${service.id}`), 'bob')).status, 404);
        assert.equal((await call('DELETE', path(`/${service.id}`), 'alice')).status, 202);
        assert.equal((await call('GET', path(`/${service.id}`), 'alice')).status, 404);
        assert.ok(!(await listServiceRows(db.pool)).some((row) => row.service.id === service.id));
    });
});

describe('Jobs', () => {
    let projectId: string;
    let job: JobDetails;
    const digest = (c: string) => `sha256:${c.repeat(64)}`;
    const path = (rest = '') => `/v1/projects/${projectId}/jobs${rest}`;
    const input = { name: 'nightly', image: 'ghcr.io/acme/api:v1', command: ['node', 'dist/nightly.js'], memoryMb: 256, cpuMillicores: 250 };
    const issues = async (response: Response) => JSON.stringify(await response.json());

    before(async () => {
        const response = await call('POST', '/v1/projects', 'alice', { accountId: accountA, name: 'job-tests' });
        projectId = ((await response.json()) as Project).id;
        images.set('acme/api:v1', digest('1'));
        images.set('acme/private:v1', digest('2'));
    });

    test('created with its tag pinned, the default timeout and no schedule; deploying', async () => {
        const response = await call('POST', path(), 'alice', input);
        assert.equal(response.status, 201);
        job = (await response.json()) as JobDetails;
        assert.equal(job.imageDigest, digest('1'));
        assert.deepEqual(job.command, ['node', 'dist/nightly.js']);
        assert.equal(job.args, null);
        assert.equal(job.timeoutSeconds, 3600);
        assert.equal(job.schedule, null);
        assert.equal(job.timeZone, null);
        assert.equal(job.registryAuth, false);
        assert.equal(job.state, 'deploying');
        assert.equal((await call('POST', path(), 'alice', input)).status, 409);
    });

    test("ready once the CronJob carries the row's current spec, deploying while it carries an older one", async () => {
        const stateNow = async () => ((await (await call('GET', path(`/${job.id}`), 'alice')).json()) as JobDetails).state;
        const row = (await listJobRows(db.pool, projectId)).find((candidate) => candidate.job.id === job.id);
        assert.ok(row);
        cronJobs.set(`job-${job.id}`, { specVersion: jobSpecVersion(row), uid: 'u', jobTemplate: undefined });
        assert.equal(await stateNow(), 'ready');
        cronJobs.set(`job-${job.id}`, { specVersion: 'an older spec', uid: 'u', jobTemplate: undefined });
        assert.equal(await stateNow(), 'deploying');
        const listed = (await (await call('GET', path(), 'alice')).json()) as JobDetails[];
        assert.deepEqual(listed.map((candidate) => [candidate.name, candidate.state]), [['nightly', 'deploying']]);
        cronJobs.delete(`job-${job.id}`);
    });

    test("a new Database changes the Job's spec, so its runs get its DATABASE_URL only once applied", async () => {
        const rowNow = async () => (await listJobRows(db.pool, projectId)).find((candidate) => candidate.job.id === job.id);
        const before = await rowNow();
        assert.deepEqual(before?.databases, []);
        const created = await call('POST', `/v1/projects/${projectId}/databases`, 'alice', { name: 'jobs-db', memoryMb: 256, storageGb: 1 });
        const database = (await created.json()) as { id: string };
        const after = await rowNow();
        assert.deepEqual(after?.databases, [{ id: database.id, name: 'jobs-db' }]);
        assert.ok(before !== undefined && after !== undefined && jobSpecVersion(before) !== jobSpecVersion(after));
        assert.equal((await call('DELETE', `/v1/projects/${projectId}/databases/${database.id}`, 'alice')).status, 202);
    });

    test('schedules, time zones, command and timeout are checked before anything is written', async () => {
        const refused = async (extra: Record<string, unknown>, expected: RegExp) => {
            const response = await call('POST', path(), 'alice', { ...input, name: 'refused', ...extra });
            assert.equal(response.status, 400, JSON.stringify(extra));
            assert.match(await issues(response), expected);
        };
        await refused({ schedule: '0 25 * * *' }, /hour: 25 is outside 0-23/);
        await refused({ schedule: '@every 5m' }, /not one of/);
        await refused({ schedule: '0 3 * * *', timeZone: 'Mars/Base' }, /IANA time zone/);
        await refused({ timeZone: 'Europe/Berlin' }, /timeZone needs a schedule/);
        await refused({ command: [] }, /command/);
        await refused({ args: ['x'.repeat(9000), 'y'.repeat(9000)] }, /more than 16384/);
        await refused({ timeoutSeconds: 86401 }, /timeoutSeconds/);
        await refused({ memoryMb: 32 }, /memoryMb/);
        assert.equal((await db.pool.query(`select 1 from jobs where name = 'refused'`)).rowCount, 0);
    });

    test('a Cron job: its schedule is stored trimmed with its time zone', async () => {
        const response = await call('POST', path(), 'alice', { ...input, name: 'cleanup', schedule: ' */15 * * * * ', timeZone: 'Europe/Berlin' });
        assert.equal(response.status, 201);
        const created = (await response.json()) as JobDetails;
        assert.equal(created.schedule, '*/15 * * * *');
        assert.equal(created.timeZone, 'Europe/Berlin');
        const rows = await listJobRows(db.pool, projectId);
        assert.deepEqual(rows.find((row) => row.job.id === created.id)?.job.schedule, '*/15 * * * *');
        // Removing the schedule removes its time zone; setting one alone again is refused.
        const unscheduled = await call('PATCH', path(`/${created.id}`), 'alice', { schedule: null });
        assert.equal(unscheduled.status, 200);
        const body = (await unscheduled.json()) as JobDetails;
        assert.equal(body.schedule, null);
        assert.equal(body.timeZone, null);
        assert.equal((await call('PATCH', path(`/${created.id}`), 'alice', { timeZone: 'UTC' })).status, 400);
        assert.equal((await call('PATCH', path(`/${created.id}`), 'alice', { schedule: '@daily', timeZone: 'UTC' })).status, 200);
        assert.equal((await call('DELETE', path(`/${created.id}`), 'alice')).status, 202);
    });

    test('PATCH: a new tag is resolved again; command, args and resources alone are not', async () => {
        images.set('acme/api:v2', digest('4'));
        const patched = await call('PATCH', path(`/${job.id}`), 'alice', { image: 'ghcr.io/acme/api:v2', args: ['--full'] });
        assert.equal(patched.status, 200);
        const body = (await patched.json()) as JobDetails;
        assert.equal(body.imageDigest, digest('4'));
        assert.deepEqual(body.args, ['--full']);
        images.set('acme/api:v2', digest('5'));
        const changed = (await (await call('PATCH', path(`/${job.id}`), 'alice', { command: null, memoryMb: 512, timeoutSeconds: 60 })).json()) as JobDetails;
        assert.equal(changed.imageDigest, digest('4'));
        assert.equal(changed.command, null);
        assert.deepEqual(changed.args, ['--full']);
        assert.equal(changed.memoryMb, 512);
        assert.equal(changed.timeoutSeconds, 60);
    });

    test('deploy resolves the same tag again and pins its new digest', async () => {
        const deployed = await call('POST', path(`/${job.id}/deploy`), 'alice');
        assert.equal(deployed.status, 200);
        const body = (await deployed.json()) as JobDetails;
        assert.equal(body.imageDigest, digest('5'));
        assert.ok(body.deployedAt > job.deployedAt);
    });

    test("a private image's credentials are sealed, never returned, and rendered for kubelet with the Services'", async () => {
        const image = 'ghcr.io/acme/private:v1';
        assert.equal((await call('POST', path(), 'alice', { ...input, name: 'private', image })).status, 400);
        const created = await call('POST', path(), 'alice', { ...input, name: 'private', image, registryAuth: { username: 'ci', password: 'token' } });
        assert.equal(created.status, 201);
        const body = (await created.json()) as JobDetails;
        assert.equal(body.registryAuth, true);
        assert.ok(!JSON.stringify(body).includes('token'));
        const stored = await db.pool.query<{ registry_auth: Buffer }>('select registry_auth from jobs where id = $1', [body.id]);
        assert.ok(!stored.rows[0]?.registry_auth.toString('latin1').includes('token'));
        // The API writes the Project's Secrets right after answering.
        const rendered = async () =>
            appliedSecrets
                .filter((secret) => secret.metadata.namespace === `project-${projectId}` && secret.metadata.name === 'project-registry-auth')
                .at(-1);
        for (let attempt = 0; attempt < 50 && (await rendered()) === undefined; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const config = JSON.parse(Buffer.from((await rendered())?.data['.dockerconfigjson'] ?? '', 'base64').toString()) as {
            auths: Record<string, { username: string }>;
        };
        assert.equal(config.auths['ghcr.io/acme/private']?.username, 'ci');
        // A deploy pulls with the stored credentials.
        assert.equal((await call('POST', path(`/${body.id}/deploy`), 'alice')).status, 200);
        assert.equal((await call('DELETE', path(`/${body.id}`), 'alice')).status, 202);
    });

    test('the operator gets the pinned image and where the runs go', async () => {
        const row = (await listJobRows(db.pool)).find((candidate) => candidate.job.id === job.id);
        assert.equal(row?.pinnedImage, `ghcr.io/acme/api@${digest('5')}`);
        assert.equal(row?.site, 'hetzner-fsn1');
        assert.equal((await call('PATCH', path(`/${job.id}`), 'alice', { homeSite: 'ovh-lim' })).status, 200);
        assert.equal((await listJobRows(db.pool)).find((candidate) => candidate.job.id === job.id)?.site, 'ovh-lim');
    });

    test('a run starts only once the CronJob has the current template; a One-off job copies it with its own args and env', async () => {
        const runsPath = path(`/${job.id}/runs`);
        assert.equal((await call('POST', runsPath, 'alice')).status, 409, 'no CronJob yet');
        const row = (await listJobRows(db.pool, projectId)).find((candidate) => candidate.job.id === job.id);
        assert.ok(row);
        const jobTemplate = {
            metadata: { labels: { 'openupstream.io/job-id': job.id, 'openupstream.io/component': 'jobs' } },
            spec: { template: { spec: { containers: [{ name: 'job', image: row.pinnedImage, args: ['--full'] }] } } },
        };
        cronJobs.set(`job-${job.id}`, { specVersion: 'an older spec', uid: 'cron-uid', jobTemplate });
        assert.equal((await call('POST', runsPath, 'alice')).status, 409, 'an older template');
        cronJobs.set(`job-${job.id}`, { specVersion: jobSpecVersion(row), uid: 'cron-uid', jobTemplate });
        const started = await call('POST', runsPath, 'alice', { args: ['--only', '42'], env: { ORDER_ID: '42' } });
        assert.equal(started.status, 201);
        const run = (await started.json()) as JobRun;
        assert.deepEqual([run.jobId, run.trigger, run.state], [job.id, 'api', 'pending']);
        assert.equal(started.headers.get('location'), `/v1/projects/${projectId}/jobs/${job.id}/runs/${run.id}`);
        const container = (runs.get(run.id)?.spec as { template: { spec: { containers: { args: string[]; env: unknown }[] } } }).template.spec
            .containers[0];
        assert.deepEqual(container?.args, ['--only', '42']);
        assert.deepEqual(container?.env, [{ name: 'ORDER_ID', value: '42' }]);
        // Without a body the run takes the Job's args.
        assert.equal((await call('POST', runsPath, 'alice')).status, 201);
    });

    test('runs list newest first, scheduled ones included; one can be read and deleted', async () => {
        const runsPath = path(`/${job.id}/runs`);
        runs.set(`job-${job.id}-29384756`, {
            apiVersion: 'batch/v1',
            kind: 'Job',
            metadata: {
                name: `job-${job.id}-29384756`,
                namespace: `project-${projectId}`,
                labels: { 'openupstream.io/job-id': job.id },
                creationTimestamp: new Date('2026-01-01T03:00:00Z'),
            },
            status: { conditions: [{ type: 'Complete', status: 'True' }], completionTime: new Date('2026-01-01T03:01:00Z') },
        });
        const listed = (await (await call('GET', runsPath, 'alice')).json()) as JobRun[];
        assert.equal(listed.length, 3);
        assert.deepEqual(listed.at(-1), {
            id: `job-${job.id}-29384756`,
            jobId: job.id,
            trigger: 'schedule',
            state: 'succeeded',
            reason: null,
            createdAt: '2026-01-01T03:00:00.000Z',
            startedAt: null,
            finishedAt: '2026-01-01T03:01:00.000Z',
        });
        const [newest] = listed;
        assert.ok(newest);
        assert.equal(((await (await call('GET', `${runsPath}/${newest.id}`, 'alice')).json()) as JobRun).id, newest.id);
        assert.equal((await call('GET', `${runsPath}/job-${job.id}-nothere`, 'alice')).status, 404);
        assert.equal((await call('GET', `${runsPath}/svc-${job.id}-abc`, 'alice')).status, 404);
        assert.equal((await call('GET', runsPath, 'bob')).status, 404);
        assert.equal((await call('DELETE', `${runsPath}/${newest.id}`, 'bob')).status, 404);
        assert.equal((await call('DELETE', `${runsPath}/${newest.id}`, 'alice')).status, 204);
        assert.equal((await call('DELETE', `${runsPath}/${newest.id}`, 'alice')).status, 404);
        kubeDown = true;
        assert.equal((await call('GET', runsPath, 'alice')).status, 503);
        assert.equal((await call('POST', runsPath, 'alice')).status, 503);
        kubeDown = false;
    });

    test("a run's logs come from its pod, found by the run's name; only a run of the Job is looked up", async () => {
        const runId = `job-${job.id}-29384757`;
        pods.set(`project-${projectId} batch.kubernetes.io/job-name=${runId}`, [
            { name: `${runId}-x1`, nodeName: 'node-1', containers: [{ name: 'job', state: 'terminated', restartCount: 0 }] },
        ]);
        podLogs.set(`${runId}-x1/job`, ['2026-11-09T03:00:00Z done 42 tasks']);
        const response = await call('GET', path(`/${job.id}/runs/${runId}/logs`), 'alice');
        assert.equal(response.status, 200);
        assert.equal(((JSON.parse(await response.text()) as LogEntry)).line, 'done 42 tasks');
        assert.equal((await call('GET', path(`/${job.id}/runs/svc-${job.id}-abc/logs`), 'alice')).status, 404);
        assert.equal((await call('GET', path(`/${job.id}/runs/${runId}/logs`), 'bob')).status, 404);
    });

    test('a run is checked before it starts; an Account with a Hold starts none', async () => {
        const runsPath = path(`/${job.id}/runs`);
        const before = runs.size;
        assert.equal((await call('POST', runsPath, 'alice', { env: { 'NOT-A-NAME': 'x' } })).status, 400);
        assert.equal((await call('POST', runsPath, 'alice', { args: [] })).status, 400);
        assert.equal((await call('POST', runsPath, 'alice', { image: 'nginx' })).status, 400);
        const malformed = await api.request(runsPath, {
            method: 'POST',
            headers: { authorization: 'Bearer madauth_alice_write', 'content-type': 'application/json' },
            body: '{"args": ["42"',
        });
        assert.equal(malformed.status, 400, 'a broken body is not taken for none');
        const big = await call('POST', runsPath, 'alice', { env: { A: 'x'.repeat(9000), B: 'y'.repeat(9000) } });
        assert.equal(big.status, 400);
        assert.match(JSON.stringify(await big.json()), /more than 16384/);
        assert.equal(await placeHold(db.pool, accountA, 'unpaid'), true);
        const held = await call('POST', runsPath, 'alice');
        assert.equal(held.status, 402);
        assert.deepEqual(((await held.json()) as { holds: string[] }).holds, ['unpaid']);
        assert.equal(await liftHold(db.pool, accountA, 'unpaid'), true);
        assert.equal(runs.size, before);
    });

    test("another Account's Project: 404; deleted: 202, then gone", async () => {
        assert.equal((await call('GET', path(`/${job.id}`), 'bob')).status, 404);
        assert.equal((await call('DELETE', path(`/${job.id}`), 'bob')).status, 404);
        assert.equal((await call('DELETE', path(`/${job.id}`), 'alice')).status, 202);
        assert.equal((await call('GET', path(`/${job.id}`), 'alice')).status, 404);
        assert.equal((await call('DELETE', path(`/${job.id}`), 'alice')).status, 404);
        assert.ok(!(await listJobRows(db.pool)).some((row) => row.job.id === job.id));
    });
});

describe('Holds', () => {
    /** The API as the platform runs it with a billing service: new Accounts wait for a payment method. */
    let gated: ReturnType<typeof createApi>;
    let accountId: string;
    let projectId: string;

    before(() => {
        gated = createApi({
            pool: db.pool,
            kube,
            storage,
            ...domainDeps,
            newAccountHolds: ['payment-method'],
            authenticate: madauthAuthenticator(sessionVerifier({ issuer: ISSUER, keys: createLocalJWKSet({ keys: [] }) }), apiKeys),
        });
    });

    const gatedCall = (method: string, path: string, body?: unknown) =>
        gated.request(path, {
            method,
            headers: { authorization: 'Bearer madauth_erin_write', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    const createDb = (name: string) => gatedCall('POST', `/v1/projects/${projectId}/databases`, { name, memoryMb: 256, storageGb: 1 });

    test('a new Account starts with the configured Holds and shows them', async () => {
        const created = await gatedCall('POST', '/v1/accounts', { name: 'Erin AG' });
        assert.equal(created.status, 201);
        const account = (await created.json()) as Account;
        accountId = account.id;
        assert.deepEqual(account.holds, ['payment-method']);
        const listed = (await (await gatedCall('GET', '/v1/accounts')).json()) as Account[];
        assert.deepEqual(listed.map((a) => a.holds), [['payment-method']]);
    });

    test('Projects are free; a Resource in an Account with a Hold: 402', async () => {
        const project = await gatedCall('POST', '/v1/projects', { accountId, name: 'shop' });
        assert.equal(project.status, 201);
        projectId = ((await project.json()) as Project).id;
        const refused = await createDb('orders');
        assert.equal(refused.status, 402);
        assert.deepEqual(await refused.json(), {
            error: 'this Account may not create Resources now: payment-method',
            holds: ['payment-method'],
        });
        assert.equal((await db.pool.query('select 1 from databases where project_id = $1', [projectId])).rowCount, 0);
    });

    test('lifting the last Hold lets it create Resources; another Hold stops it again', async () => {
        assert.equal(await placeHold(db.pool, accountId, 'unpaid'), true);
        assert.equal(await liftHold(db.pool, accountId, 'payment-method'), true);
        assert.equal((await createDb('orders')).status, 402);
        assert.equal(await liftHold(db.pool, accountId, 'unpaid'), true);
        assert.equal((await createDb('orders')).status, 201);
        assert.equal(await placeHold(db.pool, accountId, 'unpaid'), true);
        assert.equal(await placeHold(db.pool, accountId, 'unpaid'), true, 'placing it twice is the same');
        assert.equal((await createDb('invoices')).status, 402);
        // The schema refuses every kind of Resource, whichever route inserts it.
        await assert.rejects(
            db.pool.query(`insert into buckets (project_id, name, garage_bucket_id, access_key_id) values ($1, 'erin-assets', 'b', 'GK')`, [
                projectId,
            ]),
            /has a Hold/,
        );
        assert.equal((await gatedCall('POST', `/v1/projects/${projectId}/buckets`, { name: 'erin-assets' })).status, 402);
        assert.ok(!storage.calls.includes('create erin-assets'), 'a held Account makes no Garage calls');
        await assert.rejects(
            db.pool.query(
                `insert into services (project_id, name, image, image_digest, memory_mb, cpu_millicores, port)
                 values ($1, 'web', 'nginx', 'sha256:${'0'.repeat(64)}', 128, 100, 80)`,
                [projectId],
            ),
            /has a Hold/,
        );
        await assert.rejects(
            db.pool.query(
                `insert into jobs (project_id, name, image, image_digest, memory_mb, cpu_millicores, timeout_seconds)
                 values ($1, 'nightly', 'nginx', 'sha256:${'0'.repeat(64)}', 128, 100, 60)`,
                [projectId],
            ),
            /has a Hold/,
        );
        // The Database it already has stays.
        assert.equal((await gatedCall('GET', `/v1/projects/${projectId}/databases`)).status, 200);
        assert.equal(await liftHold(db.pool, accountId, 'unpaid'), true);
        assert.equal(await liftHold(db.pool, accountId, 'unpaid'), true, 'lifting a Hold that is not there is fine');
    });

    test('without configured Holds a new Account may create Resources at once', async () => {
        const account = (await (await call('POST', '/v1/accounts', 'frank', { name: 'Frank' })).json()) as Account;
        assert.deepEqual(account.holds, []);
    });

    test('the billing view of an Account has its Members; unknown Accounts are reported', async () => {
        const { rows } = await db.pool.query<{ id: string; created_at: Date }>(
            `insert into accounts (name) values ('Gina') returning id, created_at`,
        );
        const [{ id, created_at }] = rows as [{ id: string; created_at: Date }];
        await db.pool.query(
            `insert into members (account_id, auth_subject, email, role, created_at) values
             ($1, 'gina', 'gina@g.test', 'owner', now()), ($1, 'hal', 'hal@g.test', 'developer', now() + interval '1 second')`,
            [id],
        );
        await placeHold(db.pool, id, 'payment-method');
        assert.deepEqual(await getAccountRecord(db.pool, id), {
            id,
            name: 'Gina',
            createdAt: created_at.toISOString(),
            holds: ['payment-method'],
            members: [
                { authSubject: 'gina', email: 'gina@g.test', role: 'owner' },
                { authSubject: 'hal', email: 'hal@g.test', role: 'developer' },
            ],
        });
        const unknown = '00000000-0000-4000-8000-0000000000ff';
        assert.equal(await getAccountRecord(db.pool, unknown), undefined);
        assert.equal(await placeHold(db.pool, unknown, 'unpaid'), false);
        assert.equal(await liftHold(db.pool, unknown, 'unpaid'), false);
    });
});

describe("Usage: what a Project's Resources use now", () => {
    let projectId: string;
    let database: DatabaseDetails;
    let namespace: string;

    before(async () => {
        const response = await call('POST', '/v1/projects', 'alice', { accountId: accountA, name: 'usage-tests' });
        projectId = ((await response.json()) as Project).id;
        namespace = `project-${projectId}`;
        const created = await call('POST', `/v1/projects/${projectId}/databases`, 'alice', { name: 'main', memoryMb: 512, storageGb: 10 });
        assert.equal(created.status, 201);
        database = (await created.json()) as DatabaseDetails;
        pods.set(`${namespace} openupstream.io/project-id=${projectId}`, [
            { name: `db-${database.id}-1`, nodeName: 'node-lim', containers: [{ name: 'postgres', restartCount: 1, state: 'running' }], phase: 'Running', startedAt: new Date('2026-11-15T10:00:00Z'), terminating: false },
        ]);
    });

    test('each Resource with its instances and what Prometheus measured, for Members only', async () => {
        prometheusAnswers = async (query) =>
            ok([{ labels: { pod: `db-${database.id}-1` }, value: query === cpuQuery(namespace) ? 0.25 : query === memoryQuery(namespace) ? 1000 : query === diskQuery(namespace, 'shared') ? 2000 : -1 }]);
        const response = await call('GET', `/v1/projects/${projectId}/usage`, 'alice');
        assert.equal(response.status, 200);
        const usage = (await response.json()) as ProjectUsage;
        assert.equal(usage.measured, true);
        assert.ok(Math.abs(Date.parse(usage.measuredAt) - Date.now()) < 60_000);
        assert.deepEqual(usage.resources, [
            {
                kind: 'database',
                id: database.id,
                name: 'main',
                cpuMillicores: { used: 250, allocated: null },
                memoryBytes: { used: 1000, allocated: 512 * 2 ** 20 },
                storageBytes: { used: 2000, allocated: 10 * 2 ** 30 },
                instances: [
                    { name: '1', role: 'database', site: 'ovh-lim', state: 'running', restarts: 1, startedAt: '2026-11-15T10:00:00.000Z', cpuMillicores: 250, memoryBytes: 1000, storageBytes: 2000 },
                ],
            },
        ]);
        assert.equal((await call('GET', `/v1/projects/${projectId}/usage`, 'bob')).status, 404);
        assert.equal((await call('GET', `/v1/projects/${projectId}/usage`)).status, 401);
    });

    test('Prometheus down: the instances are listed, nothing is measured', async () => {
        prometheusAnswers = async () => err('connect ECONNREFUSED');
        const usage = (await (await call('GET', `/v1/projects/${projectId}/usage`, 'alice')).json()) as ProjectUsage;
        assert.equal(usage.measured, false);
        assert.deepEqual(usage.resources[0]?.memoryBytes, { used: null, allocated: 512 * 2 ** 20 });
        assert.deepEqual(usage.resources[0]?.instances.map((instance) => [instance.name, instance.state, instance.cpuMillicores]), [['1', 'running', null]]);
    });

    test('the cluster not answering is a 503', async () => {
        kubeDown = true;
        try {
            assert.equal((await call('GET', `/v1/projects/${projectId}/usage`, 'alice')).status, 503);
        } finally {
            kubeDown = false;
        }
    });
});
