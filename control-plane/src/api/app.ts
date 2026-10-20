/**
 * The public API (ARCHITECTURE.md, "Control plane"): the caller's Accounts,
 * and the Projects, Databases and Buckets in them. Every route under /v1 except the
 * health check needs a madAuth session token or API key (./auth.ts); an
 * API key needs `openupstream:read` for GET and `openupstream:write` for
 * anything else. Another Account's Project answers 404, like one that does
 * not exist.
 */
import {
    API_KEY_SCOPES,
    BUCKET_NAME,
    COMPUTE_SITES,
    DATABASE_MIN_MEMORY_MB,
    DNS_LABEL,
    UUID,
    type Bucket,
    type BucketDetails,
    type Database,
    type DatabaseDetails,
    type DatabaseState,
    clusterName,
    poolerName,
    projectNamespace,
} from '@openupstream/sdk';
import { type Context, Hono } from 'hono';
import type pg from 'pg';
import { z } from 'zod';
import { createAccount, holdsOf, listAccounts } from '../accounts/store.js';
import { type BucketRecord, createBucket, deleteBucket, getBucket, listBuckets } from '../buckets/store.js';
import { createDatabase, deleteDatabase, getDatabase, listDatabases } from '../databases/store.js';
import { GARAGE_REGION, type ObjectStorage } from '../garage.js';
import { type ControlPlaneKube, stateOf } from '../kube.js';
import { createProject, deleteProject, getProject, listProjects } from '../projects/store.js';
import { type Result, ok } from '../result.js';
import { type Authenticate, type Identity, accountsOf } from './auth.js';

export interface ApiDeps {
    readonly pool: pg.Pool;
    readonly authenticate: Authenticate;
    readonly kube: ControlPlaneKube;
    readonly storage: ObjectStorage;
    /** Where Buckets are reached: `<bucket>.s3.<customerDomain>` (decision 68). */
    readonly customerDomain: string;
    /** The Holds every new Account starts with (ARCHITECTURE.md, decision 78). */
    readonly newAccountHolds?: readonly string[];
    readonly log?: (entry: Record<string, unknown>) => void;
}


const accountInput = z.strictObject({
    name: z.string().trim().min(1).max(200),
});

/** Whether an API key with `scopes` may make a request with `method`; a session (undefined) may make any. */
export const scopeAllows = (scopes: readonly string[] | undefined, method: string): boolean =>
    scopes === undefined ||
    scopes.includes(API_KEY_SCOPES.write) ||
    ((method === 'GET' || method === 'HEAD') && scopes.includes(API_KEY_SCOPES.read));

const projectInput = z.strictObject({
    accountId: z.string().regex(UUID),
    name: z.string().regex(DNS_LABEL, 'a DNS label: lowercase letters, digits and hyphens'),
});

const databaseInput = z.strictObject({
    name: z.string().regex(DNS_LABEL, 'a DNS label: lowercase letters, digits and hyphens'),
    homeSite: z.enum(COMPUTE_SITES).optional(),
    memoryMb: z.int().min(DATABASE_MIN_MEMORY_MB),
    storageGb: z.int().min(1),
});

const bucketInput = z.strictObject({
    name: z.string().regex(BUCKET_NAME, 'a hostname label of 3 to 63 lowercase letters, digits and hyphens'),
});

/** In-cluster connection through the Database's PgBouncer; CloudNativePG's application user and database. */
const connectionOf = (database: Database) => ({
    host: `${poolerName(database)}.${projectNamespace(database.projectId)}.svc.cluster.local`,
    port: 5432,
    database: 'app',
    user: 'app',
});

type Env = { Variables: { identity: Identity; accountIds: string[] } };

export function createApi(deps: ApiDeps): Hono<Env> {
    const { pool, authenticate, kube, storage } = deps;
    const app = new Hono<Env>();

    /** The state from the Cluster; `unknown` when Kubernetes cannot be asked, rather than failing the request. */
    const stateFor = async (database: Database): Promise<DatabaseState> => {
        const cluster = await kube.readCluster(projectNamespace(database.projectId), clusterName(database));
        if (!cluster.ok) {
            deps.log?.({ msg: 'cannot read Cluster', database: database.id, error: cluster.error });
            return 'unknown';
        }
        return stateOf(cluster.value);
    };
    const details = async (database: Database): Promise<DatabaseDetails> => ({
        ...database,
        state: await stateFor(database),
        connection: connectionOf(database),
    });

    app.get('/v1/health', (c) => c.json({ ok: true }));

    app.use('/v1/*', async (c, next) => {
        const token = /^Bearer (\S+)$/.exec(c.req.header('authorization') ?? '')?.[1];
        if (token === undefined) {
            return c.json({ error: 'bearer token required' }, 401);
        }
        const identity = await authenticate(token);
        if (!identity.ok) {
            if (identity.error.kind === 'unavailable') {
                deps.log?.({ msg: 'cannot verify tokens', error: identity.error.reason });
                return c.json({ error: 'cannot verify tokens now' }, 503);
            }
            return c.json({ error: 'invalid token' }, 401);
        }
        if (!scopeAllows(identity.value.scopes, c.req.method)) {
            const needed = c.req.method === 'GET' ? API_KEY_SCOPES.read : API_KEY_SCOPES.write;
            return c.json({ error: `this API key lacks the scope ${needed}` }, 403);
        }
        c.set('identity', identity.value);
        c.set('accountIds', await accountsOf(pool, identity.value));
        return next();
    });

    const invalid = (issues: z.core.$ZodIssue[]) => ({
        error: 'invalid request',
        issues: issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
    const body = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => undefined);
    /** An Account with a Hold, e.g. one without a payment method yet, creates no Resources (the schema refuses them). */
    const held = (c: Context<Env>, holds: string[]) =>
        c.json({ error: `this Account may not create Resources now: ${holds.join(', ')}`, holds }, 402);

    app.get('/v1/accounts', async (c) => c.json(await listAccounts(pool, c.get('identity').subject)));

    app.post('/v1/accounts', async (c) => {
        const input = accountInput.safeParse(await body(c));
        if (!input.success) {
            return c.json(invalid(input.error.issues), 400);
        }
        const { subject, email } = c.get('identity');
        if (email === undefined) {
            return c.json({ error: 'your madAuth user has no e-mail address' }, 400);
        }
        const account = await createAccount(pool, subject, email, input.data.name, deps.newAccountHolds ?? []);
        c.header('location', `/v1/accounts/${account.id}`);
        return c.json(account, 201);
    });

    app.get('/v1/projects', async (c) => c.json(await listProjects(pool, c.get('accountIds'))));

    app.post('/v1/projects', async (c) => {
        const input = projectInput.safeParse(await body(c));
        if (!input.success) {
            return c.json(invalid(input.error.issues), 400);
        }
        if (!c.get('accountIds').includes(input.data.accountId)) {
            return c.json({ error: 'not a Member of that Account' }, 403);
        }
        const created = await createProject(pool, input.data.accountId, input.data.name);
        if (!created.ok) {
            return c.json({ error: `a Project named ${created.error.name} exists` }, 409);
        }
        c.header('location', `/v1/projects/${created.value.id}`);
        return c.json(created.value, 201);
    });

    /** The caller's live Project, or undefined for anything else, including a malformed id. */
    const projectOf = (accountIds: string[], id: string) =>
        UUID.test(id) ? getProject(pool, accountIds, id) : Promise.resolve(undefined);
    const notFound = { error: 'not found' };

    app.get('/v1/projects/:projectId', async (c) => {
        const project = await projectOf(c.get('accountIds'), c.req.param('projectId'));
        return project === undefined ? c.json(notFound, 404) : c.json(project);
    });

    app.delete('/v1/projects/:projectId', async (c) => {
        const id = c.req.param('projectId');
        const deleted = UUID.test(id) && (await deleteProject(pool, c.get('accountIds'), id));
        return deleted ? c.body(null, 202) : c.json(notFound, 404);
    });

    app.get('/v1/projects/:projectId/databases', async (c) => {
        const project = await projectOf(c.get('accountIds'), c.req.param('projectId'));
        if (project === undefined) {
            return c.json(notFound, 404);
        }
        return c.json(await Promise.all((await listDatabases(pool, project.id)).map(details)));
    });

    app.post('/v1/projects/:projectId/databases', async (c) => {
        const project = await projectOf(c.get('accountIds'), c.req.param('projectId'));
        if (project === undefined) {
            return c.json(notFound, 404);
        }
        const input = databaseInput.safeParse(await body(c));
        if (!input.success) {
            return c.json(invalid(input.error.issues), 400);
        }
        const { homeSite, ...rest } = input.data;
        const created = await createDatabase(pool, project.id, homeSite === undefined ? rest : { ...rest, homeSite });
        if (!created.ok) {
            return created.error.kind === 'held'
                ? held(c, await holdsOf(pool, project.accountId))
                : c.json({ error: `a Database named ${created.error.name} exists` }, 409);
        }
        c.header('location', `/v1/projects/${project.id}/databases/${created.value.id}`);
        // The operator creates the Cluster within one pass.
        const response: DatabaseDetails = { ...created.value, state: 'provisioning', connection: connectionOf(created.value) };
        return c.json(response, 201);
    });

    const databaseOf = async (accountIds: string[], projectId: string, id: string) => {
        const project = await projectOf(accountIds, projectId);
        return project === undefined || !UUID.test(id) ? undefined : getDatabase(pool, project.id, id);
    };

    app.get('/v1/projects/:projectId/databases/:databaseId', async (c) => {
        const database = await databaseOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('databaseId'));
        return database === undefined ? c.json(notFound, 404) : c.json(await details(database));
    });

    app.delete('/v1/projects/:projectId/databases/:databaseId', async (c) => {
        const database = await databaseOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('databaseId'));
        const deleted = database !== undefined && (await deleteDatabase(pool, database.projectId, database.id));
        return deleted ? c.body(null, 202) : c.json(notFound, 404);
    });

    /** The Bucket without its Garage ids, which are ours. */
    const publicBucket = ({ id, projectId, name, createdAt }: BucketRecord): Bucket => ({ id, projectId, name, createdAt });
    /** The Bucket with its key; Garage keeps the secret, so it is asked each time. */
    const detailsOf = async (bucket: BucketRecord): Promise<Result<BucketDetails, string>> => {
        const secret = await storage.secretOf(bucket.accessKeyId);
        return secret.ok
            ? ok({
                  ...publicBucket(bucket),
                  access: {
                      endpoint: `https://${bucket.name}.s3.${deps.customerDomain}`,
                      region: GARAGE_REGION,
                      accessKeyId: bucket.accessKeyId,
                      secretAccessKey: secret.value,
                  },
              })
            : secret;
    };
    const unavailable = (c: Context<Env>, reason: string) => {
        deps.log?.({ msg: 'object storage unavailable', error: reason });
        return c.json({ error: 'object storage is unavailable now' }, 503);
    };

    app.get('/v1/projects/:projectId/buckets', async (c) => {
        const project = await projectOf(c.get('accountIds'), c.req.param('projectId'));
        if (project === undefined) {
            return c.json(notFound, 404);
        }
        return c.json((await listBuckets(pool, project.id)).map(publicBucket));
    });

    app.post('/v1/projects/:projectId/buckets', async (c) => {
        const project = await projectOf(c.get('accountIds'), c.req.param('projectId'));
        if (project === undefined) {
            return c.json(notFound, 404);
        }
        const input = bucketInput.safeParse(await body(c));
        if (!input.success) {
            return c.json(invalid(input.error.issues), 400);
        }
        // Checked first so a held Account makes no Garage calls; the schema checks again.
        const holds = await holdsOf(pool, project.accountId);
        if (holds.length > 0) {
            return held(c, holds);
        }
        const created = await createBucket(pool, storage, project.id, input.data.name);
        if (!created.ok) {
            switch (created.error.kind) {
                case 'held':
                    return held(c, await holdsOf(pool, project.accountId));
                case 'name-taken':
                    return c.json({ error: `the Bucket name ${created.error.name} is taken` }, 409);
                case 'project-deleted':
                    return c.json(notFound, 404);
                case 'unavailable':
                    return unavailable(c, created.error.reason);
            }
        }
        const details = await detailsOf(created.value);
        if (!details.ok) {
            return unavailable(c, details.error);
        }
        c.header('location', `/v1/projects/${project.id}/buckets/${created.value.id}`);
        return c.json(details.value, 201);
    });

    const bucketOf = async (accountIds: string[], projectId: string, id: string) => {
        const project = await projectOf(accountIds, projectId);
        return project === undefined || !UUID.test(id) ? undefined : getBucket(pool, project.id, id);
    };

    app.get('/v1/projects/:projectId/buckets/:bucketId', async (c) => {
        const bucket = await bucketOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('bucketId'));
        if (bucket === undefined) {
            return c.json(notFound, 404);
        }
        const details = await detailsOf(bucket);
        return details.ok ? c.json(details.value) : unavailable(c, details.error);
    });

    app.delete('/v1/projects/:projectId/buckets/:bucketId', async (c) => {
        const bucket = await bucketOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('bucketId'));
        const deleted = bucket !== undefined && (await deleteBucket(pool, bucket.projectId, bucket.id));
        return deleted ? c.body(null, 202) : c.json(notFound, 404);
    });

    app.notFound((c) => c.json(notFound, 404));
    app.onError((error, c) => {
        deps.log?.({ msg: 'request failed', path: c.req.path, error: error.message });
        return c.json({ error: 'internal error' }, 500);
    });
    return app;
}
