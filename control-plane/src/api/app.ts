/**
 * The public API (ARCHITECTURE.md, "Control plane"): the caller's Accounts,
 * and the Projects, Databases, Buckets, Services, Jobs, Domains, routing table and Secrets in them. Every route under /v1 except the
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
    HOSTNAME,
    JOB_LIMITS,
    LOG_LIMITS,
    PATH_PREFIX,
    SECRET_NAME,
    SECRET_VALUE_MAX_BYTES,
    SECRETS_MAX_TOTAL_BYTES,
    SERVICE_LIMITS,
    SERVICE_ID_LABEL,
    UUID,
    type Bucket,
    type BucketDetails,
    type Database,
    type DatabaseDetails,
    type DatabaseState,
    type Job,
    type JobDetails,
    type JobRow,
    type JobRun,
    type JobState,
    JOB_ID_LABEL,
    type RegistryAuth,
    type RouteInput,
    type Service,
    type ServiceDetails,
    type ServiceRow,
    type ServiceState,
    clusterName,
    databaseConnection,
    jobObjectName,
    jobSpecVersion,
    projectNamespace,
    serviceObjectName,
    serviceSpecVersion,
} from '@openupstream/sdk';
import { randomUUID } from 'node:crypto';
import { type Context, Hono } from 'hono';
import { stream } from 'hono/streaming';
import type pg from 'pg';
import { z } from 'zod';
import { createAccount, holdsOf, listAccounts } from '../accounts/store.js';
import { type BucketRecord, createBucket, deleteBucket, getBucket, listBuckets } from '../buckets/store.js';
import { checkRestore, restoreCheckMessage } from '../databases/restore.js';
import { createDatabase, deleteDatabase, getDatabase, getRestoreSource, listDatabases } from '../databases/store.js';
import type { TxtLookup } from '../domains/dns.js';
import { createCustomDomain, deleteDomain, getDomain, isReserved, listDomains, verifyDomain } from '../domains/store.js';
import { GARAGE_REGION, type ObjectStorage } from '../garage.js';
import { type JobChanges, createJob, deleteJob, getJob, jobRegistryAuthName, listJobRows, listJobs, sealedJobRegistryAuth, updateJob } from '../jobs/store.js';
import { byNewest, isRunOf, runManifest, runOf } from '../jobs/runs.js';
import { isTimeZone, scheduleError } from '../jobs/schedule.js';
import { openLogStream } from '../logs/stream.js';
import { type ControlPlaneKube, jobStateOf, serviceStateOf, stateOf } from '../kube.js';
import { type RegistryDeps, type ResolveError, parseImageReference, resolveDigest } from '../registry.js';
import { createProject, deleteProject, getProject, listProjects } from '../projects/store.js';
import { type Result, ok } from '../result.js';
import { createRoute, deleteRoute, listRoutes } from '../routes/store.js';
import type { KeyEncryptionKey } from '../secrets/envelope.js';
import { syncProjectSecrets } from '../secrets/render.js';
import { deleteSecret, listSecrets, openProjectValue, putSecret, sealProjectValue } from '../secrets/store.js';
import {
    type ServiceChanges,
    createService,
    deleteService,
    getService,
    listServiceRows,
    listServices,
    registryAuthName,
    sealedRegistryAuth,
    updateService,
} from '../services/store.js';
import { type Authenticate, type Identity, accountsOf } from './auth.js';

export interface ApiDeps {
    readonly pool: pg.Pool;
    readonly authenticate: Authenticate;
    readonly kube: ControlPlaneKube;
    readonly storage: ObjectStorage;
    /** Wraps the Projects' data keys; Secrets are encrypted with those. */
    readonly kek: KeyEncryptionKey;
    /** Where Services' images are resolved to digests (decision 92). */
    readonly registry: RegistryDeps;
    /** Where Buckets are reached: `<bucket>.s3.<customerDomain>` (decision 68). */
    readonly customerDomain: string;
    /** Our own hostnames (decision 67); neither it nor the customer domain can be claimed as a custom domain. */
    readonly platformDomain: string;
    /** Where custom domains' TXT ownership proofs are looked up. */
    readonly lookupTxt: TxtLookup;
    /** Where `oup login` signs in (decision 87); without it, `GET /v1/login` answers 404. */
    readonly cliLogin?: { readonly issuer: string; readonly clientId: string };
    /** The Holds every new Account starts with (ARCHITECTURE.md, decision 78). */
    readonly newAccountHolds?: readonly string[];
    /** How often a followed log stream lists the pods again, and how long it lasts at most (default LOG_LIMITS). */
    readonly logStream?: { readonly pollMs: number; readonly maxMs: number };
    readonly log?: (entry: Record<string, unknown>) => void;
}

/** `?tail=&follow=` of the log stream. */
const logQuery = z.strictObject({
    tail: z.string().regex(/^\d{1,5}$/, 'a whole number').transform(Number).pipe(z.number().max(LOG_LIMITS.maxTailLines)).optional(),
    follow: z.enum(['true', 'false']).optional(),
});

/** Set by the Kubernetes Job controller on a run's pods: the run's name. */
const RUN_POD_LABEL = 'batch.kubernetes.io/job-name';

/** How often a followed log stream lists the pods again: new replicas show within this long. */
const LOG_POLL_MS = 5_000;


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
    restoreFrom: z
        .strictObject({
            databaseId: z.string().regex(UUID),
            // An explicit offset: a bare time would be read in some server's zone.
            targetTime: z.iso.datetime({ offset: true }).optional(),
        })
        .optional(),
});

const bucketInput = z.strictObject({
    name: z.string().regex(BUCKET_NAME, 'a hostname label of 3 to 63 lowercase letters, digits and hyphens'),
});

const domainInput = z.strictObject({
    hostname: z
        .string()
        .transform((hostname) => hostname.toLowerCase().replace(/\.$/, ''))
        .pipe(z.string().regex(HOSTNAME, 'a hostname such as www.example.com: lowercase labels of letters, digits and hyphens')),
});

const secretValueInput = z.strictObject({
    value: z
        .string()
        .refine((value) => Buffer.byteLength(value, 'utf8') <= SECRET_VALUE_MAX_BYTES, `at most ${SECRET_VALUE_MAX_BYTES} bytes`),
});

const registryAuthInput = z.strictObject({
    username: z.string().min(1).max(256),
    password: z.string().min(1).max(4096),
});

const serviceFields = {
    image: z.string().min(1).max(512),
    port: z.int().min(1).max(65535),
    replicas: z.int().min(1).max(SERVICE_LIMITS.maxReplicas),
    memoryMb: z.int().min(SERVICE_LIMITS.minMemoryMb).max(SERVICE_LIMITS.maxMemoryMb),
    cpuMillicores: z.int().min(SERVICE_LIMITS.minCpuMillicores).max(SERVICE_LIMITS.maxCpuMillicores),
};

const serviceInput = z.strictObject({
    name: z.string().regex(DNS_LABEL, 'a DNS label: lowercase letters, digits and hyphens'),
    ...serviceFields,
    port: serviceFields.port.optional(),
    replicas: serviceFields.replicas.optional(),
    homeSite: z.enum(COMPUTE_SITES).optional(),
    registryAuth: registryAuthInput.optional(),
});

const servicePatch = z.strictObject({
    image: serviceFields.image.optional(),
    port: serviceFields.port.nullable().optional(),
    replicas: serviceFields.replicas.optional(),
    memoryMb: serviceFields.memoryMb.optional(),
    cpuMillicores: serviceFields.cpuMillicores.optional(),
    homeSite: z.enum(COMPUTE_SITES).nullable().optional(),
    registryAuth: registryAuthInput.nullable().optional(),
});

/** An entrypoint or its arguments: at least one entry; null in a PATCH removes it. */
const argList = z.array(z.string().max(JOB_LIMITS.maxArgsTotalBytes)).min(1).max(JOB_LIMITS.maxArgs);

const jobFields = {
    image: serviceFields.image,
    command: argList,
    args: argList,
    memoryMb: z.int().min(JOB_LIMITS.minMemoryMb).max(JOB_LIMITS.maxMemoryMb),
    cpuMillicores: z.int().min(JOB_LIMITS.minCpuMillicores).max(JOB_LIMITS.maxCpuMillicores),
    timeoutSeconds: z.int().min(1).max(JOB_LIMITS.maxTimeoutSeconds),
    schedule: z
        .string()
        .max(200)
        .transform((schedule) => schedule.trim())
        .superRefine((schedule, ctx) => {
            const error = scheduleError(schedule);
            if (error !== undefined) {
                ctx.addIssue({ code: 'custom', message: error });
            }
        }),
    timeZone: z.string().max(64).refine(isTimeZone, 'an IANA time zone such as Europe/Berlin'),
};

const jobInput = z.strictObject({
    name: z.string().regex(DNS_LABEL, 'a DNS label: lowercase letters, digits and hyphens'),
    image: jobFields.image,
    command: jobFields.command.optional(),
    args: jobFields.args.optional(),
    memoryMb: jobFields.memoryMb,
    cpuMillicores: jobFields.cpuMillicores,
    timeoutSeconds: jobFields.timeoutSeconds.optional(),
    schedule: jobFields.schedule.optional(),
    timeZone: jobFields.timeZone.optional(),
    homeSite: z.enum(COMPUTE_SITES).optional(),
    registryAuth: registryAuthInput.optional(),
});

const jobPatch = z.strictObject({
    image: jobFields.image.optional(),
    command: jobFields.command.nullable().optional(),
    args: jobFields.args.nullable().optional(),
    memoryMb: jobFields.memoryMb.optional(),
    cpuMillicores: jobFields.cpuMillicores.optional(),
    timeoutSeconds: jobFields.timeoutSeconds.optional(),
    schedule: jobFields.schedule.nullable().optional(),
    timeZone: jobFields.timeZone.nullable().optional(),
    homeSite: z.enum(COMPUTE_SITES).nullable().optional(),
    registryAuth: registryAuthInput.nullable().optional(),
});

const runInput = z.strictObject({
    args: argList.optional(),
    env: z
        .record(z.string().regex(SECRET_NAME, 'an environment variable name'), z.string())
        .refine((env) => Object.keys(env).length <= JOB_LIMITS.maxArgs, `at most ${JOB_LIMITS.maxArgs} variables`)
        .optional(),
});

const bytesOf = (texts: readonly string[]): number => texts.reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0);

/** Why a Job's command, args and time zone do not fit together; undefined when they do. */
const jobShapeError = (job: Pick<Job, 'command' | 'args' | 'schedule' | 'timeZone'>): string | undefined => {
    const bytes = bytesOf([...(job.command ?? []), ...(job.args ?? [])]);
    if (bytes > JOB_LIMITS.maxArgsTotalBytes) {
        return `command and args take ${bytes} bytes, more than ${JOB_LIMITS.maxArgsTotalBytes}`;
    }
    return job.timeZone !== null && job.schedule === null ? 'timeZone needs a schedule' : undefined;
};

const pathPrefix = z.string().regex(PATH_PREFIX, '`/` or `/segment[/segment…]`, without a trailing slash');
const routeInput = z.union([
    z.strictObject({ pathPrefix, bucketId: z.string().regex(UUID), spaFallback: z.boolean().optional() }),
    z.strictObject({ pathPrefix, serviceId: z.string().regex(UUID) }),
]);

/** In-cluster connection through the Database's PgBouncer; CloudNativePG's application user and database. */
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
        connection: databaseConnection(database),
    });

    app.get('/v1/health', (c) => c.json({ ok: true }));

    // Before the authentication below: the CLI asks this before it has a token.
    app.get('/v1/login', (c) => (deps.cliLogin === undefined ? c.json(notFound, 404) : c.json(deps.cliLogin)));

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
        const created = await createProject(pool, input.data.accountId, input.data.name, deps.customerDomain);
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
        const { homeSite, restoreFrom, ...rest } = input.data;
        if (restoreFrom !== undefined) {
            // A held Account learns that first, not after the backup checks.
            const holds = await holdsOf(pool, project.accountId);
            if (holds.length > 0) {
                return held(c, holds);
            }
            const source = await getRestoreSource(pool, project.id, restoreFrom.databaseId);
            if (source === undefined) {
                return c.json({ error: `no Database ${restoreFrom.databaseId} in this Project to restore from` }, 400);
            }
            const window = await kube.readRecoveryWindow(projectNamespace(project.id), clusterName(source));
            if (!window.ok) {
                deps.log?.({ msg: 'cannot read ObjectStore', database: source.id, error: window.error });
                return c.json({ error: 'cannot check the backups now' }, 503);
            }
            const targetTime = restoreFrom.targetTime === undefined ? undefined : new Date(restoreFrom.targetTime);
            const checked = checkRestore(source, window.value, targetTime, new Date());
            if (!checked.ok) {
                return c.json({ error: restoreCheckMessage(source.id, checked.error) }, checked.error.kind === 'no-backup' ? 409 : 400);
            }
        }
        const created = await createDatabase(pool, project.id, {
            ...rest,
            ...(homeSite === undefined ? {} : { homeSite }),
            ...(restoreFrom === undefined
                ? {}
                : {
                      restoreFrom: {
                          databaseId: restoreFrom.databaseId,
                          ...(restoreFrom.targetTime === undefined ? {} : { targetTime: new Date(restoreFrom.targetTime).toISOString() }),
                      },
                  }),
        });
        if (!created.ok) {
            return created.error.kind === 'held'
                ? held(c, await holdsOf(pool, project.accountId))
                : c.json({ error: `a Database named ${created.error.name} exists` }, 409);
        }
        c.header('location', `/v1/projects/${project.id}/databases/${created.value.id}`);
        // The operator creates the Cluster within one pass.
        const response: DatabaseDetails = { ...created.value, state: 'provisioning', connection: databaseConnection(created.value) };
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
    /**
     * The Bucket with its key. The secret only for a caller that may write,
     * since the key may write too; Garage keeps it, so it is asked each time.
     */
    const detailsOf = async (bucket: BucketRecord, identity: Identity): Promise<Result<BucketDetails, string>> => {
        const access = {
            endpoint: `https://${bucket.name}.s3.${deps.customerDomain}`,
            region: GARAGE_REGION,
            accessKeyId: bucket.accessKeyId,
        };
        if (!scopeAllows(identity.scopes, 'POST')) {
            return ok({ ...publicBucket(bucket), access });
        }
        const secret = await storage.secretOf(bucket.accessKeyId);
        return secret.ok ? ok({ ...publicBucket(bucket), access: { ...access, secretAccessKey: secret.value } }) : secret;
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
        const details = await detailsOf(created.value, c.get('identity'));
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
        const details = await detailsOf(bucket, c.get('identity'));
        return details.ok ? c.json(details.value) : unavailable(c, details.error);
    });

    app.delete('/v1/projects/:projectId/buckets/:bucketId', async (c) => {
        const bucket = await bucketOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('bucketId'));
        const deleted = bucket === undefined ? 'not-found' : await deleteBucket(pool, bucket.projectId, bucket.id);
        if (bucket === undefined || deleted === 'not-found') {
            return c.json(notFound, 404);
        }
        if (deleted === 'routed') {
            return c.json({ error: 'a Route serves this Bucket; delete the Route first' }, 409);
        }
        // Its objects go with the next cleanup pass; nothing written from now on would survive it.
        const revoked = await storage.deleteKey(bucket.accessKeyId);
        if (!revoked.ok) {
            deps.log?.({ msg: 'cannot delete a deleted Bucket\'s key now; the cleanup will', bucket: bucket.id, error: revoked.error });
        }
        return c.body(null, 202);
    });

    app.get('/v1/projects/:projectId/domains', async (c) => {
        const project = await projectOf(c.get('accountIds'), c.req.param('projectId'));
        return project === undefined ? c.json(notFound, 404) : c.json(await listDomains(pool, project.id));
    });

    app.post('/v1/projects/:projectId/domains', async (c) => {
        const project = await projectOf(c.get('accountIds'), c.req.param('projectId'));
        if (project === undefined) {
            return c.json(notFound, 404);
        }
        const input = domainInput.safeParse(await body(c));
        if (!input.success) {
            return c.json(invalid(input.error.issues), 400);
        }
        const { hostname } = input.data;
        if (isReserved(hostname, [deps.customerDomain, deps.platformDomain])) {
            return c.json({ error: `hostnames under ${deps.customerDomain} and ${deps.platformDomain} are the platform's` }, 400);
        }
        const created = await createCustomDomain(pool, project.id, hostname);
        if (!created.ok) {
            return created.error.kind === 'claimed'
                ? c.json({ error: `this Project has claimed ${hostname} already` }, 409)
                : c.json({ error: `${hostname} is verified for another Project` }, 409);
        }
        c.header('location', `/v1/projects/${project.id}/domains/${created.value.id}`);
        return c.json(created.value, 201);
    });

    const domainOf = async (accountIds: string[], projectId: string, id: string) => {
        const project = await projectOf(accountIds, projectId);
        return project === undefined || !UUID.test(id) ? undefined : getDomain(pool, project.id, id);
    };

    app.post('/v1/projects/:projectId/domains/:domainId/verify', async (c) => {
        const domain = await domainOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('domainId'));
        if (domain === undefined) {
            return c.json(notFound, 404);
        }
        const verified = await verifyDomain(pool, deps.lookupTxt, domain.projectId, domain.id);
        if (!verified.ok) {
            switch (verified.error.kind) {
                case 'not-found':
                    return c.json(notFound, 404);
                case 'not-published': {
                    const { txtRecord, found } = verified.error;
                    return c.json({ error: `no TXT record ${txtRecord.name} with the value ${txtRecord.value} yet`, txtRecord, found }, 409);
                }
                case 'in-use':
                    return c.json({ error: 'this hostname is verified for another Project' }, 409);
                case 'unavailable':
                    deps.log?.({ msg: 'TXT lookup failed', domain: domain.id, error: verified.error.reason });
                    return c.json({ error: 'cannot look up the TXT record now' }, 503);
            }
        }
        return c.json(verified.value);
    });

    app.delete('/v1/projects/:projectId/domains/:domainId', async (c) => {
        const domain = await domainOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('domainId'));
        if (domain === undefined) {
            return c.json(notFound, 404);
        }
        const deleted = await deleteDomain(pool, storage, domain.projectId, domain.id);
        if (!deleted.ok) {
            return deleted.error.kind === 'not-found'
                ? c.json(notFound, 404)
                : c.json({ error: 'the default Domain is deleted with its Project only' }, 409);
        }
        for (const error of deleted.value.websiteErrors) {
            deps.log?.({ msg: 'cannot stop serving a Bucket that has no Route left', domain: domain.id, error });
        }
        return c.body(null, 204);
    });

    app.get('/v1/projects/:projectId/domains/:domainId/routes', async (c) => {
        const domain = await domainOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('domainId'));
        return domain === undefined ? c.json(notFound, 404) : c.json(await listRoutes(pool, domain.id));
    });

    app.post('/v1/projects/:projectId/domains/:domainId/routes', async (c) => {
        const domain = await domainOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('domainId'));
        if (domain === undefined) {
            return c.json(notFound, 404);
        }
        const input = routeInput.safeParse(await body(c));
        if (!input.success) {
            return c.json(invalid(input.error.issues), 400);
        }
        const data = input.data;
        const route: RouteInput =
            'serviceId' in data
                ? data
                : { pathPrefix: data.pathPrefix, bucketId: data.bucketId, ...(data.spaFallback === undefined ? {} : { spaFallback: data.spaFallback }) };
        const created = await createRoute(pool, storage, domain.projectId, domain.id, route);
        if (!created.ok) {
            switch (created.error.kind) {
                case 'domain-not-found':
                    return c.json(notFound, 404);
                case 'bucket-not-found':
                    return c.json({ error: 'no such Bucket in this Project' }, 400);
                case 'service-not-found':
                    return c.json({ error: 'no such Service in this Project' }, 400);
                case 'service-without-port':
                    return c.json({ error: 'the Service has no port: it serves no HTTP, so no Route can send to it' }, 409);
                case 'prefix-taken':
                    return c.json({ error: `the Domain has a Route at ${created.error.pathPrefix}` }, 409);
                case 'spa-conflict':
                    return c.json(
                        { error: `the Bucket's other Routes have spaFallback ${created.error.spaFallback}; every Route to a Bucket has the same` },
                        409,
                    );
                case 'unavailable':
                    return unavailable(c, created.error.reason);
            }
        }
        c.header('location', `/v1/projects/${domain.projectId}/domains/${domain.id}/routes/${created.value.id}`);
        return c.json(created.value, 201);
    });

    app.delete('/v1/projects/:projectId/domains/:domainId/routes/:routeId', async (c) => {
        const domain = await domainOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('domainId'));
        const routeId = c.req.param('routeId');
        if (domain === undefined || !UUID.test(routeId)) {
            return c.json(notFound, 404);
        }
        const deleted = await deleteRoute(pool, storage, domain.id, routeId);
        if (deleted.kind === 'not-found') {
            return c.json(notFound, 404);
        }
        if (deleted.websiteError !== undefined) {
            deps.log?.({ msg: 'cannot stop serving a Bucket that has no Route left', route: routeId, error: deleted.websiteError });
        }
        return c.body(null, 204);
    });

    /** Each Project's last queued Secrets write, which the next one waits for. */
    const secretWrites = new Map<string, Promise<void>>();
    /** Projects with a queued write that has not started yet; it will read any later change too. */
    const waitingWrites = new Set<string>();

    /**
     * Writes the Project's Kubernetes Secret now, so a change reaches its
     * Services at once, without making the caller wait for Kubernetes: the
     * change is stored, and the secrets pass writes it again within one
     * interval if this fails. A Project's writes run one after another, each
     * reading the values when it starts, so an earlier write that reads
     * before a change cannot land after the write that follows it. At most
     * one write waits: it reads every change made before it starts.
     */
    const syncSecrets = (projectId: string): void => {
        if (waitingWrites.has(projectId)) {
            return;
        }
        waitingWrites.add(projectId);
        const write = (secretWrites.get(projectId) ?? Promise.resolve())
            .then(() => {
                waitingWrites.delete(projectId);
                return syncProjectSecrets({ pool, kube, kek: deps.kek }, projectId);
            })
            .then(
                (synced) => {
                    if (!synced.ok) {
                        deps.log?.({ msg: 'cannot write the Secrets of a Project', projectId, error: synced.error });
                    }
                },
                (error: unknown) =>
                    deps.log?.({ msg: 'cannot write the Secrets of a Project', projectId, error: error instanceof Error ? error.message : String(error) }),
            );
        secretWrites.set(projectId, write);
        void write.then(() => {
            if (secretWrites.get(projectId) === write) {
                secretWrites.delete(projectId);
            }
        });
    };

    app.get('/v1/projects/:projectId/secrets', async (c) => {
        const project = await projectOf(c.get('accountIds'), c.req.param('projectId'));
        return project === undefined ? c.json(notFound, 404) : c.json(await listSecrets(pool, project.id));
    });

    app.put('/v1/projects/:projectId/secrets/:name', async (c) => {
        const project = await projectOf(c.get('accountIds'), c.req.param('projectId'));
        if (project === undefined) {
            return c.json(notFound, 404);
        }
        const name = c.req.param('name');
        if (!SECRET_NAME.test(name)) {
            return c.json({ error: 'a Secret name is an environment variable name: letters, digits and _, not starting with a digit' }, 400);
        }
        const input = secretValueInput.safeParse(await body(c));
        if (!input.success) {
            return c.json(invalid(input.error.issues), 400);
        }
        const stored = await putSecret(pool, deps.kek, project.id, { name, value: input.data.value });
        if (!stored.ok) {
            switch (stored.error.kind) {
                case 'too-large':
                    return c.json({ error: `the Project's Secrets would take ${stored.error.bytes} bytes, more than ${SECRETS_MAX_TOTAL_BYTES}` }, 400);
                case 'project-not-found':
                    return c.json(notFound, 404);
                case 'invalid-name':
                case 'envelope':
                    throw new Error(`cannot store the Secret: ${stored.error.kind}`);
            }
        }
        syncSecrets(project.id);
        const created = stored.value.createdAt === stored.value.updatedAt;
        if (created) {
            c.header('location', `/v1/projects/${project.id}/secrets/${name}`);
        }
        return c.json(stored.value, created ? 201 : 200);
    });

    app.delete('/v1/projects/:projectId/secrets/:name', async (c) => {
        const project = await projectOf(c.get('accountIds'), c.req.param('projectId'));
        if (project === undefined || !(await deleteSecret(pool, project.id, c.req.param('name')))) {
            return c.json(notFound, 404);
        }
        syncSecrets(project.id);
        return c.body(null, 204);
    });

    /**
     * The state from the Deployment, compared with the spec the row asks for
     * now (`wanted`, from listServiceRows); `unknown` when Kubernetes cannot be
     * asked, rather than failing the request.
     */
    const serviceStateFor = async (service: Service, wanted: ServiceRow | undefined): Promise<ServiceState> => {
        const deployment = await kube.readDeployment(projectNamespace(service.projectId), serviceObjectName(service));
        if (!deployment.ok) {
            deps.log?.({ msg: 'cannot read Deployment', service: service.id, error: deployment.error });
            return 'unknown';
        }
        return serviceStateOf(deployment.value, wanted === undefined ? '' : serviceSpecVersion(wanted));
    };
    /** The Services with their state; the rows they are compared with are read once for all of them. */
    const servicesDetails = async (services: readonly Service[]): Promise<ServiceDetails[]> => {
        const projectIds = [...new Set(services.map((service) => service.projectId))];
        const rows = (await Promise.all(projectIds.map((projectId) => listServiceRows(pool, projectId)))).flat();
        return Promise.all(
            services.map(async (service) => ({
                ...service,
                state: await serviceStateFor(service, rows.find((row) => row.service.id === service.id)),
            })),
        );
    };
    const serviceDetails = async (service: Service): Promise<ServiceDetails> => (await servicesDetails([service]))[0] as ServiceDetails;

    /** The digest the image points at now, as the registry answers it with the Service's credentials. */
    const resolve = async (image: string, auth: RegistryAuth | undefined): Promise<Result<string, ResolveError>> => {
        const reference = parseImageReference(image);
        return reference.ok ? resolveDigest(deps.registry, reference.value, auth) : { ok: false, error: { kind: 'invalid', reason: reference.error } };
    };
    const unresolved = (c: Context<Env>, image: string, error: ResolveError) => {
        switch (error.kind) {
            case 'invalid':
                return c.json({ error: `invalid image ${image}: ${error.reason}` }, 400);
            case 'not-found':
                return c.json({ error: `the registry has no image ${image}` }, 400);
            case 'unauthorized':
                return c.json({ error: `the registry refused to serve ${image}; check registryAuth` }, 400);
            case 'forbidden-address':
                return c.json({ error: `${error.host} is not a public registry` }, 400);
            case 'unavailable':
                deps.log?.({ msg: 'registry unavailable', image, error: error.reason });
                return c.json({ error: `the registry of ${image} cannot be reached now` }, 503);
        }
    };
    const registryOf = (image: string) => {
        const reference = parseImageReference(image);
        return reference.ok ? reference.value.registry : undefined;
    };
    const sameRegistry = (a: string, b: string) => registryOf(a) !== undefined && registryOf(a) === registryOf(b);
    /** Seals credentials bound to `boundTo`, a Service's or Job's registryAuthName. */
    const sealAuthAs = (projectId: string, boundTo: string, auth: RegistryAuth) =>
        sealProjectValue(pool, deps.kek, projectId, boundTo, JSON.stringify(auth));
    /** Credentials sealed bound to `boundTo`, opened; undefined when there are none. */
    const openAuth = async (projectId: string, boundTo: string, sealed: Buffer | undefined): Promise<RegistryAuth | undefined> => {
        if (sealed === undefined) {
            return undefined;
        }
        const opened = await openProjectValue(pool, deps.kek, projectId, boundTo, sealed);
        if (!opened.ok) {
            throw new Error(`cannot open the registry credentials ${boundTo}: ${opened.error.kind}`);
        }
        return JSON.parse(opened.value) as RegistryAuth;
    };
    /** The Service's stored credentials, opened; undefined when it has none. */
    const storedAuth = async (service: Service): Promise<RegistryAuth | undefined> =>
        openAuth(service.projectId, registryAuthName(service.id), await sealedRegistryAuth(pool, service.projectId, service.id));
    /**
     * Stored credentials belong to the old image's registry: a new image
     * elsewhere drops them (null), so they never reach another registry;
     * otherwise what the request gave.
     */
    const authAfterChange = (
        current: { readonly image: string; readonly registryAuth: boolean },
        image: string | undefined,
        given: RegistryAuth | null | undefined,
    ): RegistryAuth | null | undefined =>
        given === undefined && image !== undefined && current.registryAuth && !sameRegistry(current.image, image) ? null : given;
    /**
     * The columns a PATCH of a Service or Job writes for its image: with a new
     * image or new credentials, the tag resolved again with the credentials it
     * will be pulled with, and those sealed bound to `boundTo`; nothing else.
     */
    const imageChange = async (
        current: { readonly projectId: string; readonly image: string; readonly registryAuth: boolean },
        image: string | undefined,
        givenAuth: RegistryAuth | null | undefined,
        boundTo: string,
        stored: () => Promise<RegistryAuth | undefined>,
    ): Promise<
        Result<
            { readonly image?: string; readonly imageDigest?: string; readonly registryAuth?: Buffer | null },
            { readonly image: string; readonly error: ResolveError }
        >
    > => {
        const registryAuth = authAfterChange(current, image, givenAuth);
        if (image === undefined && registryAuth === undefined) {
            return ok({});
        }
        const pulled = image ?? current.image;
        const digest = await resolve(pulled, registryAuth === undefined ? await stored() : (registryAuth ?? undefined));
        if (!digest.ok) {
            return { ok: false, error: { image: pulled, error: digest.error } };
        }
        const sealed = registryAuth === undefined || registryAuth === null ? undefined : await sealAuthAs(current.projectId, boundTo, registryAuth);
        if (sealed !== undefined && !sealed.ok) {
            throw new Error(`cannot seal: ${sealed.error.kind}`);
        }
        return ok({
            ...(image === undefined ? {} : { image }),
            imageDigest: digest.value,
            ...(registryAuth === undefined ? {} : { registryAuth: sealed?.value ?? null }),
        });
    };

    app.get('/v1/projects/:projectId/services', async (c) => {
        const project = await projectOf(c.get('accountIds'), c.req.param('projectId'));
        if (project === undefined) {
            return c.json(notFound, 404);
        }
        return c.json(await servicesDetails(await listServices(pool, project.id)));
    });

    app.post('/v1/projects/:projectId/services', async (c) => {
        const project = await projectOf(c.get('accountIds'), c.req.param('projectId'));
        if (project === undefined) {
            return c.json(notFound, 404);
        }
        const input = serviceInput.safeParse(await body(c));
        if (!input.success) {
            return c.json(invalid(input.error.issues), 400);
        }
        // Checked first so a held Account makes no registry calls; the schema checks again.
        const holds = await holdsOf(pool, project.accountId);
        if (holds.length > 0) {
            return held(c, holds);
        }
        const { registryAuth, homeSite, replicas, ...rest } = input.data;
        const digest = await resolve(rest.image, registryAuth);
        if (!digest.ok) {
            return unresolved(c, rest.image, digest.error);
        }
        const id = randomUUID();
        const sealed = registryAuth === undefined ? undefined : await sealAuthAs(project.id, registryAuthName(id), registryAuth);
        if (sealed !== undefined && !sealed.ok) {
            return sealed.error.kind === 'project-not-found' ? c.json(notFound, 404) : Promise.reject(new Error(`cannot seal: ${sealed.error.kind}`));
        }
        const created = await createService(pool, project.id, {
            ...rest,
            id,
            imageDigest: digest.value,
            port: rest.port ?? null,
            replicas: replicas ?? 1,
            homeSite: homeSite ?? null,
            registryAuth: sealed?.value ?? null,
        });
        if (!created.ok) {
            switch (created.error.kind) {
                case 'held':
                    return held(c, await holdsOf(pool, project.accountId));
                case 'name-taken':
                    return c.json({ error: `a Service named ${created.error.name} exists` }, 409);
                case 'project-deleted':
                    return c.json(notFound, 404);
            }
        }
        if (registryAuth !== undefined) {
            syncSecrets(project.id);
        }
        c.header('location', `/v1/projects/${project.id}/services/${created.value.id}`);
        // The Services operator creates the Deployment within one pass.
        return c.json({ ...created.value, state: 'deploying' } satisfies ServiceDetails, 201);
    });

    const serviceOf = async (accountIds: string[], projectId: string, id: string) => {
        const project = await projectOf(accountIds, projectId);
        return project === undefined || !UUID.test(id) ? undefined : getService(pool, project.id, id);
    };

    app.get('/v1/projects/:projectId/services/:serviceId', async (c) => {
        const service = await serviceOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('serviceId'));
        return service === undefined ? c.json(notFound, 404) : c.json(await serviceDetails(service));
    });

    app.patch('/v1/projects/:projectId/services/:serviceId', async (c) => {
        const service = await serviceOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('serviceId'));
        if (service === undefined) {
            return c.json(notFound, 404);
        }
        const input = servicePatch.safeParse(await body(c));
        if (!input.success) {
            return c.json(invalid(input.error.issues), 400);
        }
        const { image, registryAuth, ...rest } = input.data;
        const change = await imageChange(service, image, registryAuth, registryAuthName(service.id), () => storedAuth(service));
        if (!change.ok) {
            return unresolved(c, change.error.image, change.error.error);
        }
        const changes: ServiceChanges = { ...rest, ...change.value };
        const updated = await updateService(pool, service.projectId, service.id, changes);
        if (!updated.ok) {
            return updated.error === 'routed'
                ? c.json({ error: 'a Route serves this Service, so it keeps a port; delete the Route first' }, 409)
                : c.json(notFound, 404);
        }
        if (change.value.registryAuth !== undefined) {
            syncSecrets(service.projectId);
        }
        return c.json(await serviceDetails(updated.value));
    });

    app.post('/v1/projects/:projectId/services/:serviceId/deploy', async (c) => {
        const service = await serviceOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('serviceId'));
        if (service === undefined) {
            return c.json(notFound, 404);
        }
        const digest = await resolve(service.image, await storedAuth(service));
        if (!digest.ok) {
            return unresolved(c, service.image, digest.error);
        }
        const updated = await updateService(pool, service.projectId, service.id, { imageDigest: digest.value });
        return updated.ok ? c.json(await serviceDetails(updated.value)) : c.json(notFound, 404);
    });

    /**
     * The log stream of the pods `selector` picks in the Project's namespace,
     * as NDJSON, one LogEntry per line (decision 21). 503 when Kubernetes
     * cannot be asked before it starts.
     */
    const logs = async (c: Context<Env>, projectId: string, selector: string) => {
        const query = logQuery.safeParse(c.req.query());
        if (!query.success) {
            return c.json(invalid(query.error.issues), 400);
        }
        const follow = query.data.follow === 'true';
        const project = await projectOf(c.get('accountIds'), projectId);
        if (project === undefined) {
            return c.json(notFound, 404);
        }
        const following = follows.get(project.accountId) ?? 0;
        if (follow && following >= LOG_LIMITS.maxFollowsPerAccount) {
            return c.json({ error: `at most ${LOG_LIMITS.maxFollowsPerAccount} followed log streams at once; end one first` }, 429);
        }
        // The request's own signal: a client that goes before the stream starts is seen too.
        const stop = new AbortController();
        const request = c.req.raw.signal;
        if (request.aborted) {
            stop.abort();
        } else {
            request.addEventListener('abort', () => stop.abort(), { once: true });
        }
        const opened = await openLogStream(
            kube,
            {
                namespace: projectNamespace(projectId),
                selector,
                tail: query.data.tail ?? LOG_LIMITS.defaultTailLines,
                follow,
                pollMs: deps.logStream?.pollMs ?? LOG_POLL_MS,
                maxMs: deps.logStream?.maxMs ?? LOG_LIMITS.maxFollowSeconds * 1000,
                log: deps.log,
            },
            stop.signal,
        );
        if (!opened.ok) {
            deps.log?.({ msg: 'cannot list pods', selector, error: opened.error });
            return kubernetesDown(c);
        }
        c.header('content-type', 'application/x-ndjson; charset=utf-8');
        c.header('cache-control', 'no-store');
        if (follow) {
            follows.set(project.accountId, (follows.get(project.accountId) ?? 0) + 1);
        }
        return stream(c, async (body) => {
            body.onAbort(() => stop.abort());
            const heartbeat = follow ? setInterval(() => void body.write('\n'), LOG_LIMITS.heartbeatSeconds * 1000) : undefined;
            try {
                for await (const entry of opened.value) {
                    // Hono drops write errors: a client that went is seen here.
                    if (body.aborted) {
                        stop.abort();
                        break;
                    }
                    await body.write(`${JSON.stringify(entry)}\n`);
                }
            } finally {
                clearInterval(heartbeat);
                stop.abort();
                if (follow) {
                    follows.set(project.accountId, (follows.get(project.accountId) ?? 1) - 1);
                }
            }
        });
    };
    /** Followed log streams open now, per Account, on this replica. */
    const follows = new Map<string, number>();
    const kubernetesDown = (c: Context<Env>) => c.json({ error: 'cannot reach Kubernetes now' }, 503);

    app.get('/v1/projects/:projectId/services/:serviceId/logs', async (c) => {
        const service = await serviceOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('serviceId'));
        return service === undefined ? c.json(notFound, 404) : logs(c, service.projectId, `${SERVICE_ID_LABEL}=${service.id}`);
    });

    app.delete('/v1/projects/:projectId/services/:serviceId', async (c) => {
        const service = await serviceOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('serviceId'));
        if (service === undefined) {
            return c.json(notFound, 404);
        }
        const deleted = await deleteService(pool, service.projectId, service.id);
        switch (deleted) {
            case 'routed':
                return c.json({ error: 'a Route still serves this Service; delete the Route first' }, 409);
            case 'not-found':
                return c.json(notFound, 404);
            case 'deleted':
                if (service.registryAuth) {
                    syncSecrets(service.projectId);
                }
                return c.body(null, 202);
        }
    });

    /**
     * The state from the CronJob, compared with the spec the row asks for now
     * (`wanted`, from listJobRows); `unknown` when Kubernetes cannot be asked.
     */
    const jobStateFor = async (job: Job, wanted: JobRow | undefined): Promise<JobState> => {
        const cronJob = await kube.readCronJob(projectNamespace(job.projectId), jobObjectName(job));
        if (!cronJob.ok) {
            deps.log?.({ msg: 'cannot read CronJob', job: job.id, error: cronJob.error });
            return 'unknown';
        }
        return jobStateOf(cronJob.value, wanted === undefined ? '' : jobSpecVersion(wanted));
    };
    /** The Jobs with their state; the rows they are compared with are read once for all of them. */
    const jobsDetails = async (jobs: readonly Job[]): Promise<JobDetails[]> => {
        const projectIds = [...new Set(jobs.map((job) => job.projectId))];
        const rows = (await Promise.all(projectIds.map((projectId) => listJobRows(pool, projectId)))).flat();
        return Promise.all(jobs.map(async (job) => ({ ...job, state: await jobStateFor(job, rows.find((row) => row.job.id === job.id)) })));
    };
    const jobDetails = async (job: Job): Promise<JobDetails> => (await jobsDetails([job]))[0] as JobDetails;
    /** The Job's stored credentials, opened; undefined when it has none. */
    const storedJobAuth = async (job: Job): Promise<RegistryAuth | undefined> =>
        openAuth(job.projectId, jobRegistryAuthName(job.id), await sealedJobRegistryAuth(pool, job.projectId, job.id));

    app.get('/v1/projects/:projectId/jobs', async (c) => {
        const project = await projectOf(c.get('accountIds'), c.req.param('projectId'));
        if (project === undefined) {
            return c.json(notFound, 404);
        }
        return c.json(await jobsDetails(await listJobs(pool, project.id)));
    });

    app.post('/v1/projects/:projectId/jobs', async (c) => {
        const project = await projectOf(c.get('accountIds'), c.req.param('projectId'));
        if (project === undefined) {
            return c.json(notFound, 404);
        }
        const input = jobInput.safeParse(await body(c));
        if (!input.success) {
            return c.json(invalid(input.error.issues), 400);
        }
        const { registryAuth, homeSite, command, args, timeoutSeconds, schedule, timeZone, ...rest } = input.data;
        const shape = { command: command ?? null, args: args ?? null, schedule: schedule ?? null, timeZone: timeZone ?? null };
        const shapeError = jobShapeError(shape);
        if (shapeError !== undefined) {
            return c.json({ error: shapeError }, 400);
        }
        // Checked first so a held Account makes no registry calls; the schema checks again.
        const holds = await holdsOf(pool, project.accountId);
        if (holds.length > 0) {
            return held(c, holds);
        }
        const digest = await resolve(rest.image, registryAuth);
        if (!digest.ok) {
            return unresolved(c, rest.image, digest.error);
        }
        const id = randomUUID();
        const sealed = registryAuth === undefined ? undefined : await sealAuthAs(project.id, jobRegistryAuthName(id), registryAuth);
        if (sealed !== undefined && !sealed.ok) {
            return sealed.error.kind === 'project-not-found' ? c.json(notFound, 404) : Promise.reject(new Error(`cannot seal: ${sealed.error.kind}`));
        }
        const created = await createJob(pool, project.id, {
            ...rest,
            ...shape,
            id,
            imageDigest: digest.value,
            timeoutSeconds: timeoutSeconds ?? JOB_LIMITS.defaultTimeoutSeconds,
            homeSite: homeSite ?? null,
            registryAuth: sealed?.value ?? null,
        });
        if (!created.ok) {
            switch (created.error.kind) {
                case 'held':
                    return held(c, await holdsOf(pool, project.accountId));
                case 'name-taken':
                    return c.json({ error: `a Job named ${created.error.name} exists` }, 409);
                case 'project-deleted':
                    return c.json(notFound, 404);
            }
        }
        if (registryAuth !== undefined) {
            syncSecrets(project.id);
        }
        c.header('location', `/v1/projects/${project.id}/jobs/${created.value.id}`);
        // The Jobs operator creates the CronJob within one pass.
        return c.json({ ...created.value, state: 'deploying' } satisfies JobDetails, 201);
    });

    const jobOf = async (accountIds: string[], projectId: string, id: string) => {
        const project = await projectOf(accountIds, projectId);
        return project === undefined || !UUID.test(id) ? undefined : getJob(pool, project.id, id);
    };

    app.get('/v1/projects/:projectId/jobs/:jobId', async (c) => {
        const job = await jobOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('jobId'));
        return job === undefined ? c.json(notFound, 404) : c.json(await jobDetails(job));
    });

    app.patch('/v1/projects/:projectId/jobs/:jobId', async (c) => {
        const job = await jobOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('jobId'));
        if (job === undefined) {
            return c.json(notFound, 404);
        }
        const input = jobPatch.safeParse(await body(c));
        if (!input.success) {
            return c.json(invalid(input.error.issues), 400);
        }
        const { image, registryAuth: givenAuth, ...rest } = input.data;
        // Without a schedule the time zone means nothing: removing the schedule removes it too, unless it is given.
        const timeZone = rest.schedule === null && rest.timeZone === undefined ? null : rest.timeZone;
        const shapeError = jobShapeError({
            command: rest.command === undefined ? job.command : rest.command,
            args: rest.args === undefined ? job.args : rest.args,
            schedule: rest.schedule === undefined ? job.schedule : rest.schedule,
            timeZone: timeZone === undefined ? job.timeZone : timeZone,
        });
        if (shapeError !== undefined) {
            return c.json({ error: shapeError }, 400);
        }
        const change = await imageChange(job, image, givenAuth, jobRegistryAuthName(job.id), () => storedJobAuth(job));
        if (!change.ok) {
            return unresolved(c, change.error.image, change.error.error);
        }
        const changes: JobChanges = { ...rest, timeZone, ...change.value };
        const updated = await updateJob(pool, job.projectId, job.id, changes);
        if (updated === undefined) {
            return c.json(notFound, 404);
        }
        if (change.value.registryAuth !== undefined) {
            syncSecrets(job.projectId);
        }
        return c.json(await jobDetails(updated));
    });

    app.post('/v1/projects/:projectId/jobs/:jobId/deploy', async (c) => {
        const job = await jobOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('jobId'));
        if (job === undefined) {
            return c.json(notFound, 404);
        }
        const digest = await resolve(job.image, await storedJobAuth(job));
        if (!digest.ok) {
            return unresolved(c, job.image, digest.error);
        }
        const updated = await updateJob(pool, job.projectId, job.id, { imageDigest: digest.value });
        return updated === undefined ? c.json(notFound, 404) : c.json(await jobDetails(updated));
    });

    app.delete('/v1/projects/:projectId/jobs/:jobId', async (c) => {
        const job = await jobOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('jobId'));
        if (job === undefined || !(await deleteJob(pool, job.projectId, job.id))) {
            return c.json(notFound, 404);
        }
        if (job.registryAuth) {
            syncSecrets(job.projectId);
        }
        // The Jobs operator removes the CronJob, and with it its runs, within one pass.
        return c.body(null, 202);
    });

    /** The Job's runs, scheduled and started, newest first; undefined when Kubernetes cannot be asked. */
    const runsOf = async (job: Job): Promise<JobRun[] | undefined> => {
        const listed = await kube.listJobs(projectNamespace(job.projectId), `${JOB_ID_LABEL}=${job.id}`);
        if (!listed.ok) {
            deps.log?.({ msg: 'cannot list runs', job: job.id, error: listed.error });
            return undefined;
        }
        return listed.value.map(runOf).sort(byNewest);
    };

    app.post('/v1/projects/:projectId/jobs/:jobId/runs', async (c) => {
        const project = await projectOf(c.get('accountIds'), c.req.param('projectId'));
        const job = project === undefined || !UUID.test(c.req.param('jobId')) ? undefined : await getJob(pool, project.id, c.req.param('jobId'));
        if (project === undefined || job === undefined) {
            return c.json(notFound, 404);
        }
        // No body starts the run as the Job is; a body that is not JSON is refused, not taken for none.
        const text = await c.req.text();
        const parsed: unknown = text.trim() === '' ? {} : await Promise.resolve(text).then(JSON.parse).catch(() => undefined);
        const input = runInput.safeParse(parsed);
        if (!input.success) {
            return c.json(invalid(input.error.issues), 400);
        }
        const { args, env } = input.data;
        const bytes = bytesOf([...(job.command ?? []), ...(args ?? job.args ?? []), ...Object.entries(env ?? {}).flat()]);
        if (bytes > JOB_LIMITS.maxArgsTotalBytes) {
            return c.json({ error: `command, args and env take ${bytes} bytes, more than ${JOB_LIMITS.maxArgsTotalBytes}` }, 400);
        }
        // A run costs like a Resource: a held Account starts none. Its Cron jobs go on, like its other Resources.
        const holds = await holdsOf(pool, project.accountId);
        if (holds.length > 0) {
            return c.json({ error: `this Account may not start runs now: ${holds.join(', ')}`, holds }, 402);
        }
        const cronJob = await kube.readCronJob(projectNamespace(job.projectId), jobObjectName(job));
        if (!cronJob.ok) {
            deps.log?.({ msg: 'cannot read CronJob', job: job.id, error: cronJob.error });
            return kubernetesDown(c);
        }
        const wanted = (await listJobRows(pool, job.projectId)).find((row) => row.job.id === job.id);
        // Started from an older template, the run would not be what the Job says now.
        if (cronJob.value === undefined || wanted === undefined || jobStateOf(cronJob.value, jobSpecVersion(wanted)) !== 'ready') {
            return c.json({ error: 'the Job is still deploying; start the run once it is ready' }, 409);
        }
        const manifest = runManifest(job.projectId, job.id, cronJob.value, { args, env });
        if (manifest === undefined) {
            throw new Error(`the CronJob of Job ${job.id} has no container to copy`);
        }
        const created = await kube.createJob(manifest);
        if (!created.ok) {
            deps.log?.({ msg: 'cannot start a run', job: job.id, error: created.error });
            return kubernetesDown(c);
        }
        if (created.value === 'exists') {
            // A random name taken already: as unlikely as it is harmless to ask again.
            return c.json({ error: 'a run of that name exists; start it again' }, 409);
        }
        c.header('location', `/v1/projects/${job.projectId}/jobs/${job.id}/runs/${manifest.metadata.name}`);
        return c.json(runOf(created.value), 201);
    });

    app.get('/v1/projects/:projectId/jobs/:jobId/runs', async (c) => {
        const job = await jobOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('jobId'));
        if (job === undefined) {
            return c.json(notFound, 404);
        }
        const runs = await runsOf(job);
        return runs === undefined ? kubernetesDown(c) : c.json(runs);
    });

    app.get('/v1/projects/:projectId/jobs/:jobId/runs/:runId', async (c) => {
        const job = await jobOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('jobId'));
        const runId = c.req.param('runId');
        if (job === undefined || !isRunOf(job.id, runId)) {
            return c.json(notFound, 404);
        }
        const runs = await runsOf(job);
        if (runs === undefined) {
            return kubernetesDown(c);
        }
        const run = runs.find((candidate) => candidate.id === runId);
        return run === undefined ? c.json(notFound, 404) : c.json(run);
    });

    app.get('/v1/projects/:projectId/jobs/:jobId/runs/:runId/logs', async (c) => {
        const job = await jobOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('jobId'));
        const runId = c.req.param('runId');
        // The Job controller labels a run's pods with the run's name.
        return job === undefined || !isRunOf(job.id, runId) ? c.json(notFound, 404) : logs(c, job.projectId, `${RUN_POD_LABEL}=${runId}`);
    });

    app.delete('/v1/projects/:projectId/jobs/:jobId/runs/:runId', async (c) => {
        const job = await jobOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('jobId'));
        const runId = c.req.param('runId');
        if (job === undefined || !isRunOf(job.id, runId)) {
            return c.json(notFound, 404);
        }
        const deleted = await kube.deleteJob(projectNamespace(job.projectId), runId);
        if (!deleted.ok) {
            deps.log?.({ msg: 'cannot delete a run', job: job.id, run: runId, error: deleted.error });
            return kubernetesDown(c);
        }
        return deleted.value === 'not-found' ? c.json(notFound, 404) : c.body(null, 204);
    });

    app.notFound((c) => c.json(notFound, 404));
    app.onError((error, c) => {
        deps.log?.({ msg: 'request failed', path: c.req.path, error: error.message });
        return c.json({ error: 'internal error' }, 500);
    });
    return app;
}
