import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { type CryptoKey, SignJWT, createLocalJWKSet, createRemoteJWKSet, exportJWK, generateKeyPair } from 'jose';
import {
    API_KEY_SCOPES,
    type Account,
    type Bucket,
    type BucketDetails,
    type DatabaseDetails,
    type Domain,
    type Project,
    type Route,
    type Secret,
    type ServiceDetails,
    type ServiceRow,
    serviceSpecVersion,
} from '@openupstream/sdk';
import { getAccountRecord, liftHold, placeHold } from '../accounts/store.js';
import { listDatabaseRows } from '../databases/rows.js';
import { ensureDefaultDomains } from '../domains/store.js';
import { listDomainRoutings } from '../routes/store.js';
import { type ClusterStatus, type ControlPlaneKube, type DeploymentStatus, type SecretManifest } from '../kube.js';
import type { RegistryDeps } from '../registry.js';
import { listServiceRows } from '../services/store.js';
import { parseKeyEncryptionKey } from '../secrets/envelope.js';
import { err, ok } from '../result.js';
import { type TestDatabase, createTestDatabase } from '../testing/postgres.js';
import { fakeStorage } from '../testing/storage.js';
import { createApi } from './app.js';
import { type Authenticate, SESSION_TOKEN_TYPE, madauthAuthenticator, sessionVerifier } from './auth.js';

const ISSUER = 'https://openupstream.test';

/** API keys as madAuth would verify them: `madauth_<subject>_<read|write|none>`. */
const apiKeys: Authenticate = async (key) => {
    const [, subject, scope] = key.split('_');
    if (subject === undefined || scope === undefined) {
        return err({ kind: 'invalid', reason: 'unknown key' });
    }
    const scopes = scope === 'read' ? [API_KEY_SCOPES.read] : scope === 'write' ? [API_KEY_SCOPES.write] : [];
    return ok({ subject, email: `${subject}@keys.test`, scopes });
};

let db: TestDatabase;
const storage = fakeStorage();
let privateKey: CryptoKey;
let otherKey: CryptoKey;
let api: ReturnType<typeof createApi>;
let accountA: string;
let accountB: string;
/** Published TXT records by name, as the fake resolver answers them; `dnsDown` makes it fail. */
const txt = new Map<string, string[]>();
let dnsDown = false;
const domainDeps = {
    customerDomain: 'openupstream.test',
    platformDomain: 'platform.test',
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

/** What the fake Kubernetes reports per Cluster name; a string is an error. */
const clusters = new Map<string, ClusterStatus | string>();

/** The Secrets the fake Kubernetes received, latest last; namespaces in `missingNamespaces` do not exist. */
const appliedSecrets: SecretManifest[] = [];
const missingNamespaces = new Set<string>();

const kube: ControlPlaneKube = {
    readCluster: async (_namespace, name) => {
        const status = clusters.get(name);
        return typeof status === 'string' ? err(status) : ok(status);
    },
    readDeployment: async (_namespace, name) => ok(deployments.get(name)),
    remove: async () => ok(undefined),
    applySecret: async (secret) => {
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
    api = createApi({
        pool: db.pool,
        kube,
        storage,
        ...domainDeps,
        authenticate: madauthAuthenticator(sessionVerifier({ issuer: ISSUER, keys: jwks }), apiKeys),
    });
    const accounts = await db.pool.query<{ id: string }>(`insert into accounts (name) values ('A'), ('B') returning id`);
    [accountA, accountB] = accounts.rows.map((row) => row.id) as [string, string];
    // alice is in A; bob in B; carol in both.
    await db.pool.query(
        `insert into members (account_id, auth_subject, email) values
         ($1, 'alice', 'alice@a.test'), ($2, 'bob', 'bob@b.test'), ($1, 'carol', 'carol@a.test'), ($2, 'carol', 'carol@b.test')`,
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
                { id: routing?.routes[0]?.id, pathPrefix: '/docs', kind: 'bucket', bucketName: 'alice-docs', spaFallback: false },
                { id: routing?.routes[1]?.id, pathPrefix: '/', kind: 'bucket', bucketName: 'alice-site', spaFallback: true },
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
        for (const hostname of ['openupstream.test', 'x.openupstream.test', 'api.platform.test']) {
            assert.equal((await claim(projectId, hostname)).status, 400, hostname);
        }
        assert.equal((await claim(projectId, 'www.shop.example')).status, 409);
        assert.equal((await claim(projectId, 'www.shop.example', 'bob')).status, 404);
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
        assert.equal((await call('DELETE', `${routes}/${route.id}`, 'alice')).status, 204);
    });

    test("another Account's Project: 404; deleted: 202, then gone", async () => {
        assert.equal((await call('GET', path(`/${service.id}`), 'bob')).status, 404);
        assert.equal((await call('DELETE', path(`/${service.id}`), 'alice')).status, 202);
        assert.equal((await call('GET', path(`/${service.id}`), 'alice')).status, 404);
        assert.ok(!(await listServiceRows(db.pool)).some((row) => row.service.id === service.id));
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
            `insert into members (account_id, auth_subject, email, created_at) values
             ($1, 'gina', 'gina@g.test', now()), ($1, 'hal', 'hal@g.test', now() + interval '1 second')`,
            [id],
        );
        await placeHold(db.pool, id, 'payment-method');
        assert.deepEqual(await getAccountRecord(db.pool, id), {
            id,
            name: 'Gina',
            createdAt: created_at.toISOString(),
            holds: ['payment-method'],
            members: [
                { authSubject: 'gina', email: 'gina@g.test' },
                { authSubject: 'hal', email: 'hal@g.test' },
            ],
        });
        const unknown = '00000000-0000-4000-8000-0000000000ff';
        assert.equal(await getAccountRecord(db.pool, unknown), undefined);
        assert.equal(await placeHold(db.pool, unknown, 'unpaid'), false);
        assert.equal(await liftHold(db.pool, unknown, 'unpaid'), false);
    });
});
