/**
 * The public API (ARCHITECTURE.md, "Control plane"): Projects and their
 * Databases in the caller's Accounts. Every route under /v1 except the
 * health check needs a madAuth JWT. Another Account's Project answers 404,
 * like one that does not exist.
 */
import {
    COMPUTE_SITES,
    DATABASE_MIN_MEMORY_MB,
    DNS_LABEL,
    UUID,
    type Database,
    type DatabaseDetails,
    type DatabaseState,
    clusterName,
    poolerName,
    projectNamespace,
} from '@openupstream/sdk';
import { Hono } from 'hono';
import type pg from 'pg';
import { z } from 'zod';
import { createDatabase, deleteDatabase, getDatabase, listDatabases } from '../databases/store.js';
import { type ControlPlaneKube, stateOf } from '../kube.js';
import { createProject, deleteProject, getProject, listProjects } from '../projects/store.js';
import { type Verify, accountsOf } from './auth.js';

export interface ApiDeps {
    readonly pool: pg.Pool;
    readonly verify: Verify;
    readonly kube: ControlPlaneKube;
    readonly log?: (entry: Record<string, unknown>) => void;
}


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

/** In-cluster connection through the Database's PgBouncer; CloudNativePG's application user and database. */
const connectionOf = (database: Database) => ({
    host: `${poolerName(database)}.${projectNamespace(database.projectId)}.svc.cluster.local`,
    port: 5432,
    database: 'app',
    user: 'app',
});

type Env = { Variables: { accountIds: string[] } };

export function createApi(deps: ApiDeps): Hono<Env> {
    const { pool, verify, kube } = deps;
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
        const verified = await verify(token);
        if (!verified.ok) {
            if (verified.error.kind === 'unavailable') {
                deps.log?.({ msg: 'cannot verify tokens', error: verified.error.reason });
                return c.json({ error: 'cannot verify tokens now' }, 503);
            }
            return c.json({ error: 'invalid token' }, 401);
        }
        const accountIds = await accountsOf(pool, verified.value.subject);
        if (accountIds.length === 0) {
            return c.json({ error: 'not a Member of any Account' }, 403);
        }
        c.set('accountIds', accountIds);
        return next();
    });

    const invalid = (issues: z.core.$ZodIssue[]) => ({
        error: 'invalid request',
        issues: issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
    const body = (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => undefined);

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
            return c.json({ error: `a Database named ${created.error.name} exists` }, 409);
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

    app.notFound((c) => c.json(notFound, 404));
    app.onError((error, c) => {
        deps.log?.({ msg: 'request failed', path: c.req.path, error: error.message });
        return c.json({ error: 'internal error' }, 500);
    });
    return app;
}
