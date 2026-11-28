/**
 * The public API (ARCHITECTURE.md, "Control plane"): the caller's Accounts,
 * and the Projects, Databases, Buckets, Services, Jobs, Domains, routing table and Secrets in them. Every route under /v1 except the
 * health check needs a madAuth session token or API key (./auth.ts), or an
 * Account token (accounts/tokens.ts, decision 144); an API key needs
 * `openupstream:read` for GET and `openupstream:write` for anything else. Another Account's Project answers 404, like one that does
 * not exist.
 */
import {
    ACCOUNT_TOKEN_MAX_DAYS,
    ACCOUNT_TOKEN_PREFIX,
    ACCOUNT_TOKEN_ROLES,
    API_KEY_SCOPES,
    BUCKET_NAME,
    SITE_ID,
    type Site,
    DATABASE_ACCESS_LEVELS,
    MEMBER_ROLES,
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
    TUNNEL_PATH,
    UUID,
    type Bucket,
    type BucketDetails,
    type Member,
    type Database,
    type DatabaseAccess,
    type DatabaseDetails,
    type DatabaseProxy,
    type DatabaseState,
    type Job,
    type JobDetails,
    type JobRow,
    type JobRun,
    type JobState,
    type Project,
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
    tunnelHostname,
    tunnelPath,
    tunnelTargetOf,
} from '@openupstream/sdk';
import { randomUUID } from 'node:crypto';
import { type Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { stream } from 'hono/streaming';
import type pg from 'pg';
import { z } from 'zod';
import { createAccount, getAccount, holdsOf, listAccounts } from '../accounts/store.js';
import {
    createAccountToken,
    listAccountTokens,
    removeTokenGrant,
    revokeAccountToken,
    rollAccountToken,
    setTokenGrant,
    tokenBySecret,
    tokenGrantsOf,
    updateAccountToken,
} from '../accounts/tokens.js';
import { type CallerGrant, changeRole, grantsOf, listMembers, memberOf, removeGrant, removeMember, setGrant } from '../accounts/members.js';
import { type BucketRecord, createBucket, deleteBucket, getBucket, listBuckets } from '../buckets/store.js';
import { GiB, MiB, databaseMemoryRoom, roomForGrowth, roomForNew } from '../databases/capacity.js';
import { checkRestore, restoreCheckMessage } from '../databases/restore.js';
import { forgetDroppedRoles, roleFor, roleSecretManifest } from '../databases/roles.js';
import { sealNewAppPassword } from '../databases/credentials.js';
import { createDatabase, deleteDatabase, getDatabase, getRestoreSource, listDatabases, updateDatabase } from '../databases/store.js';
import type { TxtLookup } from '../domains/dns.js';
import { createCustomDomain, deleteDomain, getDomain, isReserved, listDomains, verifyDomain } from '../domains/store.js';
import { GARAGE_REGION, type ObjectStorage } from '../garage.js';
import { type JobChanges, createJob, deleteJob, getJob, jobRegistryAuthName, listJobRows, listJobs, sealedJobRegistryAuth, updateJob } from '../jobs/store.js';
import { byNewest, isRunOf, runManifest, runOf } from '../jobs/runs.js';
import { isTimeZone, scheduleError } from '../jobs/schedule.js';
import { type ControlPlaneKube, jobStateOf, serviceStateOf, stateOf } from '../kube.js';
import { openLogStream, siteOf } from '../logs/stream.js';
import { type ReadSites, type Sites, chooseSite, nodesReport, siteReader } from '../sites.js';
import type { PrometheusQuery } from '../prometheus.js';
import { measure, projectPods, projectUsage, usageOf } from '../usage/live.js';
import { type RegistryDeps, type ResolveError, parseImageReference, resolveDigest } from '../registry.js';
import { createProject, deleteProject, getProject, listProjects } from '../projects/store.js';
import { type Result, err, ok } from '../result.js';
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
import { ADMIN_ROLE, type AccountTokenIdentity, type AuthError, type Authenticate, type Caller, type Identity, accountsOf } from './auth.js';

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
    /** The waitlist's host, when it is served (decision 123): ours as well. */
    readonly waitlistDomain?: string;
    /** The one Project that may claim the waitlist's host, with the TXT proof like any claim: the website's (decision 132). */
    readonly websiteProjectId?: string;
    /** The platform's Prometheus, for what Resources use now (decision 124); without it nothing is measured. */
    readonly prometheus?: PrometheusQuery;
    /** How to read a Database's disk use (config.ts, `databaseVolumes`); `dedicated` when not given. */
    readonly databaseVolumes?: 'dedicated' | 'shared';
    /** Where custom domains' TXT ownership proofs are looked up. */
    readonly lookupTxt: TxtLookup;
    /** Where `oup login` signs in (decision 87); without it, `GET /v1/login` answers 404. */
    readonly cliLogin?: { readonly issuer: string; readonly clientId: string };
    /**
     * The dashboard (decision 120): its browser sends no header but madAuth's
     * session cookie, which this checks. Without it the API reads no cookie.
     */
    readonly cookieSessions?: Authenticate;
    /** The Holds every new Account starts with (ARCHITECTURE.md, decision 78). */
    readonly newAccountHolds?: readonly string[];
    /** How often a followed log stream lists the pods again, and how long it lasts at most (default LOG_LIMITS). */
    readonly logStream?: { readonly pollMs: number; readonly maxMs: number };
    /** The compute Sites (ADR-0007); read from `kube`'s nodes, cached, when not given. */
    readonly sites?: ReadSites;
    readonly log?: (entry: Record<string, unknown>) => void;
}

/** `?tail=&follow=` of the log stream. */
const logQuery = z.strictObject({
    tail: z.string().regex(/^\d{1,5}$/, 'a whole number').transform(Number).pipe(z.number().max(LOG_LIMITS.maxTailLines)).optional(),
    follow: z.enum(['true', 'false']).optional(),
});

/** madAuth's session cookie: the session token, HttpOnly, for the platform's host alone. */
export const SESSION_COOKIE = 'madauth_session';

/** Set by the Kubernetes Job controller on a run's pods: the run's name. */
const RUN_POD_LABEL = 'batch.kubernetes.io/job-name';

/** How often a followed log stream lists the pods again: new replicas show within this long. */
const LOG_POLL_MS = 5_000;


/** Checked against the compute Sites once parsed (siteFor). */
const siteId = z.string().regex(SITE_ID, 'a Site id, as GET /v1/sites lists them');

const accountInput = z.strictObject({
    name: z.string().trim().min(1).max(200),
});

const memberPatch = z.strictObject({ role: z.enum(MEMBER_ROLES).nullable() });
const grantInput = z.strictObject({ access: z.enum(DATABASE_ACCESS_LEVELS) });

const DAY_MS = 86_400_000;
const CLOCK_SLACK_MS = 60_000;
/** An Account token's expiry: in the future, at most ACCOUNT_TOKEN_MAX_DAYS away (decision 144). */
const tokenExpiry = z.iso
    .datetime({ offset: true })
    .transform((value) => new Date(value))
    .refine((date) => date.getTime() > Date.now(), 'in the future')
    // A minute's slack, so a client whose clock runs a little ahead may still ask for the maximum.
    .refine((date) => date.getTime() <= Date.now() + ACCOUNT_TOKEN_MAX_DAYS * DAY_MS + CLOCK_SLACK_MS, `at most ${ACCOUNT_TOKEN_MAX_DAYS} days away`);
const tokenName = z.string().regex(DNS_LABEL, 'a DNS label: lowercase letters, digits and hyphens');
const tokenInput = z.strictObject({ name: tokenName, role: z.enum(ACCOUNT_TOKEN_ROLES).nullable().optional(), expiresAt: tokenExpiry });
const tokenPatch = z.strictObject({ name: tokenName.optional(), role: z.enum(ACCOUNT_TOKEN_ROLES).nullable().optional() });
const tokenRoll = z.strictObject({ expiresAt: tokenExpiry });

/** The madAuth user when the caller is one with a session or `oup`'s access token, not an API key or an Account token. */
const signedIn = (caller: Caller): Identity | undefined => (caller.kind !== 'account-token' && caller.scopes === undefined ? caller : undefined);

/** Whether the caller may make a request with `method` by its kind alone: an Account token may (its rights decide), an API key by its scopes. */
const mayCall = (caller: Caller, method: string): boolean => caller.kind === 'account-token' || scopeAllows(caller.scopes, method);

/** Whether a grant at `granted` allows `asked`: its level and those below it (decision 140). */
export const accessAllows = (granted: DatabaseAccess, asked: DatabaseAccess): boolean =>
    DATABASE_ACCESS_LEVELS.indexOf(granted) >= DATABASE_ACCESS_LEVELS.indexOf(asked);

/** Whether an API key with `scopes` may make a request with `method`; a session (undefined) may make any. */
export const scopeAllows = (scopes: readonly string[] | undefined, method: string): boolean =>
    scopes === undefined ||
    scopes.includes(API_KEY_SCOPES.write) ||
    ((method === 'GET' || method === 'HEAD') && scopes.includes(API_KEY_SCOPES.read));

const proxyInput = z.strictObject({ access: z.enum(DATABASE_ACCESS_LEVELS).optional() });

/** The Project a tunnel host names (`pg-<project id>.<customer domain>`, tunnelHostname), or undefined. */
export const tunnelProjectOf = (host: string, customerDomain: string): string | undefined => {
    const suffix = `.${customerDomain}`;
    const label = host.toLowerCase().endsWith(suffix) ? host.toLowerCase().slice(0, -suffix.length) : '';
    const id = label.startsWith('pg-') ? label.slice(3) : '';
    return UUID.test(id) ? id : undefined;
};

const projectInput = z.strictObject({
    accountId: z.string().regex(UUID),
    name: z.string().regex(DNS_LABEL, 'a DNS label: lowercase letters, digits and hyphens'),
});

const databaseInput = z.strictObject({
    name: z.string().regex(DNS_LABEL, 'a DNS label: lowercase letters, digits and hyphens'),
    homeSite: siteId.optional(),
    memoryMb: z.int().min(DATABASE_MIN_MEMORY_MB),
    storageGb: z.int().min(1),
    autoGrow: z.boolean().optional(),
    maxStorageGb: z.int().min(1).nullable().optional(),
    restoreFrom: z
        .strictObject({
            databaseId: z.string().regex(UUID),
            // An explicit offset: a bare time would be read in some server's zone.
            targetTime: z.iso.datetime({ offset: true }).optional(),
        })
        .optional(),
}).refine((input) => input.maxStorageGb == null || input.maxStorageGb >= input.storageGb, {
    message: 'at least storageGb',
    path: ['maxStorageGb'],
});

const databasePatch = z
    .strictObject({
        memoryMb: z.int().min(DATABASE_MIN_MEMORY_MB).optional(),
        storageGb: z.int().min(1).optional(),
        autoGrow: z.boolean().optional(),
        maxStorageGb: z.int().min(1).nullable().optional(),
    })
    .refine((patch) => Object.keys(patch).length > 0, 'memoryMb, storageGb, autoGrow or maxStorageGb');

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
    homeSite: siteId.optional(),
    registryAuth: registryAuthInput.optional(),
});

const servicePatch = z.strictObject({
    image: serviceFields.image.optional(),
    port: serviceFields.port.nullable().optional(),
    replicas: serviceFields.replicas.optional(),
    memoryMb: serviceFields.memoryMb.optional(),
    cpuMillicores: serviceFields.cpuMillicores.optional(),
    homeSite: siteId.nullable().optional(),
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
    homeSite: siteId.optional(),
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
    homeSite: siteId.nullable().optional(),
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
/** What a size is checked for: a new Database in its Home site, or a grow of one that exists. */
type RoomTarget = {
    readonly home: Site;
    /** The compute Sites; undefined when they cannot be read, and then a new Database's size is accepted unchecked. */
    readonly sites: Sites | undefined;
    readonly existing?: Database;
};

/** Who calls: the Accounts where their Member (or the Account token) has a role, and the grants that count for them. */
type Env = { Variables: { identity: Caller; accountIds: string[]; grants: () => Promise<CallerGrant[]> } };

export function createApi(deps: ApiDeps): Hono<Env> {
    const { pool, authenticate, kube, storage } = deps;
    const app = new Hono<Env>();
    const readSites = deps.sites ?? siteReader(() => kube.listNodes());
    const sitesDown = (c: Context<Env>) => c.json({ error: 'cannot read the Sites now' }, 503);
    /**
     * The Home site for something new or changed: `wanted` when it is a
     * compute Site, the default Site when it is not given; or the response
     * refusing it.
     */
    const siteFor = async (c: Context<Env>, wanted: string | undefined) => {
        const sites = await readSites();
        if (!sites.ok) {
            deps.log?.({ msg: 'cannot read the Sites', error: sites.error });
            return err(sitesDown(c));
        }
        const chosen = chooseSite(sites.value, wanted);
        if (!chosen.ok) {
            return err(
                chosen.error.kind === 'none'
                    ? c.json({ error: 'no compute Site has a node now' }, 503)
                    : c.json({ error: 'invalid request', issues: [{ path: 'homeSite', message: `one of ${chosen.error.sites.join(', ')}` }] }, 400),
            );
        }
        return ok({ site: chosen.value, sites: sites.value });
    };
    /** A Home site given in a request, checked; none given is fine (a Service or Job without one follows its Project). */
    const givenSite = async (c: Context<Env>, wanted: string | null | undefined) => (typeof wanted === 'string' ? siteFor(c, wanted) : ok(undefined));
    /** The default Site, for the rows of Services and Jobs without a Home site; undefined when the Sites cannot be read. */
    const defaultSite = async (): Promise<Site | undefined> => {
        const sites = await readSites();
        if (!sites.ok) {
            deps.log?.({ msg: 'cannot read the Sites', error: sites.error });
        }
        return sites.ok ? sites.value.default : undefined;
    };

    /** The state from the Cluster; `unknown` when Kubernetes cannot be asked, rather than failing the request. */
    const stateFor = async (database: Database): Promise<DatabaseState> => {
        const cluster = await kube.readCluster(projectNamespace(database.projectId), clusterName(database));
        if (!cluster.ok) {
            deps.log?.({ msg: 'cannot read Cluster', database: database.id, error: cluster.error });
            return 'unknown';
        }
        const state = stateOf(cluster.value, database);
        if (state !== 'ready') {
            return state;
        }
        // A grow resizes the running pods (decision 152): the Cluster has
        // the new size at once, its pods once their node gave it to them.
        const resizing = await kube.podsResizing(projectNamespace(database.projectId), clusterName(database), database.memoryMb);
        if (!resizing.ok) {
            deps.log?.({ msg: "cannot read the Cluster's pods", database: database.id, error: resizing.error });
            return 'unknown';
        }
        return resizing.value > 0 ? 'resizing' : 'ready';
    };
    /**
     * Whether the compute Sites have room for the Database at `wanted`
     * (decisions 109, 110 and 151): a new one needs its storage, memory and
     * the CPU share that comes with it on a node in its Home site and in one
     * other compute Site; a grow needs the extra on the nodes holding its
     * instances. A message for the 507 when not; undefined when there is
     * room, the storage is not TopoLVM (then the compute nodes are not
     * known), or Kubernetes cannot be asked: then the size is accepted, as
     * without the check, so a slow API server does not stop Databases from
     * being created.
     */
    const noRoom = async (wanted: { readonly storageGb: number; readonly memoryMb: number }, target: RoomTarget): Promise<{ readonly value: string | undefined }> => {
        const checked = await roomCheck(wanted, target);
        if (!checked.ok) {
            deps.log?.({ msg: 'cannot read the free room; size accepted unchecked', database: target.existing?.id, error: checked.error });
        }
        return { value: checked.ok ? checked.value : undefined };
    };
    const memoryRoom = async (nodes: readonly string[]): Promise<Result<Map<string, number>, string>> => {
        const free = await Promise.all(nodes.map(async (node) => [node, await kube.nodeFree(node)] as const));
        const failed = free.find(([, room]) => !room.ok);
        if (failed !== undefined && !failed[1].ok) {
            return err(failed[1].error);
        }
        return ok(
            new Map(free.flatMap(([node, room]): [string, number][] => (room.ok && room.value !== undefined ? [[node, databaseMemoryRoom(room.value)]] : []))),
        );
    };
    const roomCheck = async (wanted: { readonly storageGb: number; readonly memoryMb: number }, target: RoomTarget): Promise<Result<string | undefined, string>> => {
        const { existing, home, sites } = target;
        const storage = await kube.storageCapacity();
        if (!storage.ok || storage.value === undefined) {
            return storage.ok ? ok(undefined) : storage;
        }
        const instanceNodes = existing === undefined ? ok([]) : await kube.volumeNodes(projectNamespace(existing.projectId), clusterName(existing));
        if (!instanceNodes.ok) {
            return instanceNodes;
        }
        if (existing !== undefined && instanceNodes.value.length > 0) {
            const extraGb = Math.max(0, wanted.storageGb - existing.storageGb);
            const extraMb = Math.max(0, wanted.memoryMb - existing.memoryMb);
            const disk = roomForGrowth(storage.value, instanceNodes.value, extraGb * GiB);
            if (!disk.ok) {
                return ok(`no room to grow ${existing.name} by ${extraGb} GB now; at most ${Math.floor(disk.error.largest / GiB)} GB more`);
            }
            if (extraMb === 0) {
                return ok(undefined);
            }
            const memory = await memoryRoom(instanceNodes.value);
            if (!memory.ok) {
                return memory;
            }
            const fits = roomForGrowth(memory.value, instanceNodes.value, extraMb * MiB);
            return ok(fits.ok ? undefined : `no room for ${extraMb} MB more memory for ${existing.name} now; at most ${Math.floor(fits.error.largest / MiB)} MB more`);
        }
        if (sites === undefined) {
            return ok(undefined);
        }
        const where = `in ${home} and another compute Site`;
        const disk = roomForNew(storage.value, sites.nodes, home, wanted.storageGb * GiB);
        if (!disk.ok) {
            return ok(`no room for ${wanted.storageGb} GB ${where} now; at most ${Math.floor(disk.error.largest / GiB)} GB`);
        }
        const memory = await memoryRoom([...storage.value.keys()].filter((node) => sites.nodes.has(node)));
        if (!memory.ok) {
            return memory;
        }
        const fits = roomForNew(memory.value, sites.nodes, home, wanted.memoryMb * MiB);
        return ok(fits.ok ? undefined : `no room for ${wanted.memoryMb} MB of memory ${where} now; at most ${Math.floor(fits.error.largest / MiB)} MB`);
    };
    const insufficientStorage = (c: Context<Env>, message: string) => c.json({ error: message }, 507);

    const details = async (database: Database): Promise<DatabaseDetails> => ({
        ...database,
        state: await stateFor(database),
        connection: databaseConnection(database),
    });

    app.get('/v1/health', (c) => c.json({ ok: true }));

    // Before the authentication below: the CLI asks this before it has a token.
    app.get('/v1/login', (c) => (deps.cliLogin === undefined ? c.json(notFound, 404) : c.json(deps.cliLogin)));

    /** The Account token a secret belongs to (decision 144), looked up on every request so a revoked one stops at once. */
    const accountTokenCaller = async (secret: string): Promise<Result<AccountTokenIdentity, AuthError>> => {
        const found = await tokenBySecret(pool, secret);
        if (!found.ok) {
            return err(
                found.error === 'expired'
                    ? { kind: 'expired', reason: 'this Account token has expired; an owner gives it a new secret with oup token roll' }
                    : { kind: 'invalid', reason: 'unknown Account token' },
            );
        }
        return ok({ kind: 'account-token', ...found.value });
    };

    app.use('/v1/*', async (c, next) => {
        const token = /^Bearer (\S+)$/.exec(c.req.header('authorization') ?? '')?.[1];
        // The dashboard is served from the API's own host (decision 120), so
        // the session cookie counts only on a request the browser marks as
        // coming from a page of this origin. A page cannot set that header:
        // another site's page that makes the browser send the cookie along
        // (CSRF) is answered like no credential.
        const cookie =
            token === undefined && deps.cookieSessions !== undefined && c.req.header('sec-fetch-site') === 'same-origin'
                ? { value: getCookie(c, SESSION_COOKIE), verify: deps.cookieSessions }
                : undefined;
        const identity: Result<Caller, AuthError> | undefined =
            token !== undefined
                ? token.startsWith(ACCOUNT_TOKEN_PREFIX)
                    ? await accountTokenCaller(token)
                    : await authenticate(token)
                : cookie?.value !== undefined
                  ? await cookie.verify(cookie.value)
                  : undefined;
        if (identity === undefined) {
            return c.json({ error: 'bearer token required' }, 401);
        }
        if (!identity.ok) {
            if (identity.error.kind === 'unavailable') {
                deps.log?.({ msg: 'cannot verify tokens', error: identity.error.reason });
                return c.json({ error: 'cannot verify tokens now' }, 503);
            }
            return c.json({ error: identity.error.kind === 'expired' ? identity.error.reason : 'invalid token' }, 401);
        }
        const caller = identity.value;
        if (!mayCall(caller, c.req.method)) {
            const needed = c.req.method === 'GET' ? API_KEY_SCOPES.read : API_KEY_SCOPES.write;
            return c.json({ error: `this API key lacks the scope ${needed}` }, 403);
        }
        c.set('identity', caller);
        // A token reaches its Account through its role, or only what its grants give.
        c.set('accountIds', caller.kind === 'account-token' ? (caller.role === null ? [] : [caller.accountId]) : await accountsOf(pool, caller));
        // Read once, and only by the routes that look at grants.
        let grants: Promise<CallerGrant[]> | undefined;
        c.set('grants', () => (grants ??= caller.kind === 'account-token' ? tokenGrantsOf(pool, caller.tokenId) : grantsOf(pool, caller.subject)));
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

    /** A 403 for an Account token on a route that needs a person: it never manages the Account or sees its Members. */
    const tokenRefused = (c: Context<Env>, what: string) => c.json({ error: `an Account token cannot ${what}` }, 403);

    /** The compute Sites, read from the nodes (ADR-0007); any signed-in caller may ask. */
    app.get('/v1/sites', async (c) => {
        const sites = await readSites();
        if (!sites.ok) {
            deps.log?.({ msg: 'cannot read the Sites', error: sites.error });
            return sitesDown(c);
        }
        return c.json(sites.value.list);
    });

    /**
     * Every node and what is wrong with the Site labels (ADR-0008), for the
     * installation's admins: madAuth's role `admin`, signed in (no API key,
     * no Account token).
     */
    app.get('/v1/admin/nodes', async (c) => {
        const caller = c.get('identity');
        if (caller.kind === 'account-token' || caller.scopes !== undefined || !(caller.roles ?? []).includes(ADMIN_ROLE)) {
            return c.json({ error: "only madAuth's admins may see the nodes, signed in" }, 403);
        }
        const sites = await readSites();
        if (!sites.ok) {
            deps.log?.({ msg: 'cannot read the Sites', error: sites.error });
            return sitesDown(c);
        }
        return c.json(nodesReport(sites.value.all));
    });

    app.get('/v1/accounts', async (c) => {
        const caller = c.get('identity');
        if (caller.kind !== 'account-token') {
            return c.json(await listAccounts(pool, caller.subject));
        }
        // A token's own Account, with its role in it.
        const account = await getAccount(pool, caller.accountId);
        return c.json(account === undefined ? [] : [{ ...account, role: caller.role }]);
    });

    app.post('/v1/accounts', async (c) => {
        const input = accountInput.safeParse(await body(c));
        if (!input.success) {
            return c.json(invalid(input.error.issues), 400);
        }
        const caller = c.get('identity');
        if (caller.kind === 'account-token') {
            return tokenRefused(c, 'create Accounts');
        }
        const { subject, email } = caller;
        if (email === undefined) {
            return c.json({ error: 'your madAuth user has no e-mail address' }, 400);
        }
        const account = await createAccount(pool, subject, email, input.data.name, deps.newAccountHolds ?? []);
        c.header('location', `/v1/accounts/${account.id}`);
        return c.json(account, 201);
    });

    // Members (decisions 138, 141, 143). Owners and developers see them;
    // only an owner changes or removes another, and anyone may leave. None
    // of it with an API key: a leaked key must not change who is in. The
    // schema keeps an owner in every Account.
    const CHANGE_MEMBERS = "change the Account's Members";
    const lastOwner = { error: 'the Account would have no owner; make another Member owner first' };
    const ownersOnly = { error: 'only an owner of the Account may do this' };

    /**
     * The 403 for a caller that may not manage the Account: an Account token,
     * or an API key, which must sign in; undefined for a session or `oup`'s
     * access token.
     */
    const managementRefused = (c: Context<Env>, what: string) => {
        const caller = c.get('identity');
        return caller.kind === 'account-token'
            ? tokenRefused(c, what)
            : caller.scopes !== undefined
              ? c.json({ error: `an API key cannot ${what}; sign in` }, 403)
              : undefined;
    };
    /** The signed-in caller's Member in the Account when it has a role and the ids are well-formed; else the 403 or 404 to answer. */
    const managingMember = async (
        c: Context<Env>,
        accountId: string,
        ids: readonly string[],
        what: string,
    ): Promise<{ readonly refused: Response; readonly caller?: undefined } | { readonly refused?: undefined; readonly caller: Member }> => {
        const refused = managementRefused(c, what);
        const user = signedIn(c.get('identity'));
        if (refused !== undefined || user === undefined) {
            return { refused: refused ?? c.json(notFound, 404) };
        }
        const caller = UUID.test(accountId) ? await memberOf(pool, accountId, user.subject) : undefined;
        return caller?.role == null || !ids.every((id) => UUID.test(id)) ? { refused: c.json(notFound, 404) } : { caller };
    };

    app.get('/v1/accounts/:accountId/members', async (c) => {
        const accountId = c.req.param('accountId');
        const identity = c.get('identity');
        if (identity.kind === 'account-token') {
            return tokenRefused(c, "see the Account's Members");
        }
        if (c.get('accountIds').includes(accountId)) {
            return c.json(await listMembers(pool, accountId));
        }
        // A Member without a role sees themselves and their grants, no one else.
        const self = UUID.test(accountId) ? await memberOf(pool, accountId, identity.subject) : undefined;
        return self === undefined ? c.json(notFound, 404) : c.json([self]);
    });

    app.patch('/v1/accounts/:accountId/members/:memberId', async (c) => {
        const { accountId, memberId } = c.req.param();
        const managing = await managingMember(c, accountId, [memberId], CHANGE_MEMBERS);
        if (managing.refused !== undefined) {
            return managing.refused;
        }
        if (managing.caller.role !== 'owner') {
            return c.json(ownersOnly, 403);
        }
        const input = memberPatch.safeParse(await body(c));
        if (!input.success) {
            return c.json(invalid(input.error.issues), 400);
        }
        const changed = await changeRole(pool, accountId, memberId, input.data.role);
        if (!changed.ok) {
            return changed.error.kind === 'last-owner' ? c.json(lastOwner, 409) : c.json(notFound, 404);
        }
        // Without a role, the Postgres roles their grants do not allow are dropped, as on a removal.
        await forgetDroppedRoles(pool, kube, changed.value.dropped, deps.log ?? (() => undefined));
        return c.json(changed.value.value);
    });

    // Grants (decision 139): an owner gives a Member access to one Database
    // of the Account at a level, changes it or takes it away; never with an
    // API key. A lower level or none drops the Member's Postgres roles above
    // it while they have no role.
    const grantRefusal = async (c: Context<Env>, accountId: string, memberId: string, databaseId: string) => {
        const managing = await managingMember(c, accountId, [memberId, databaseId], CHANGE_MEMBERS);
        return managing.refused ?? (managing.caller.role === 'owner' ? undefined : c.json(ownersOnly, 403));
    };

    app.put('/v1/accounts/:accountId/members/:memberId/grants/:databaseId', async (c) => {
        const { accountId, memberId, databaseId } = c.req.param();
        const refused = await grantRefusal(c, accountId, memberId, databaseId);
        if (refused !== undefined) {
            return refused;
        }
        const input = grantInput.safeParse(await body(c));
        if (!input.success) {
            return c.json(invalid(input.error.issues), 400);
        }
        const granted = await setGrant(pool, accountId, memberId, databaseId, input.data.access);
        if (!granted.ok) {
            return c.json(notFound, 404);
        }
        await forgetDroppedRoles(pool, kube, granted.value.dropped, deps.log ?? (() => undefined));
        return c.json(granted.value.value, granted.value.created ? 201 : 200);
    });

    app.delete('/v1/accounts/:accountId/members/:memberId/grants/:databaseId', async (c) => {
        const { accountId, memberId, databaseId } = c.req.param();
        const refused = await grantRefusal(c, accountId, memberId, databaseId);
        if (refused !== undefined) {
            return refused;
        }
        const removed = await removeGrant(pool, accountId, memberId, databaseId);
        if (!removed.ok) {
            return c.json(notFound, 404);
        }
        await forgetDroppedRoles(pool, kube, removed.value, deps.log ?? (() => undefined));
        return c.body(null, 204);
    });

    // `me` is the caller: leaving the Account.
    app.delete('/v1/accounts/:accountId/members/:memberId', async (c) => {
        const refused = managementRefused(c, CHANGE_MEMBERS);
        const identity = signedIn(c.get('identity'));
        if (refused !== undefined || identity === undefined) {
            return refused ?? c.json(notFound, 404);
        }
        const { accountId, memberId } = c.req.param();
        const caller = UUID.test(accountId) ? await memberOf(pool, accountId, identity.subject) : undefined;
        const target = memberId === 'me' ? caller?.id : memberId;
        if (caller === undefined || target === undefined || !UUID.test(target) || (target !== caller.id && caller.role == null)) {
            return c.json(notFound, 404);
        }
        if (target !== caller.id && caller.role !== 'owner') {
            return c.json(ownersOnly, 403);
        }
        const removed = await removeMember(pool, accountId, target);
        if (!removed.ok) {
            return removed.error.kind === 'last-owner' ? c.json(lastOwner, 409) : c.json(notFound, 404);
        }
        // The operator drops the roles from the Clusters; their passwords and open `owner` sessions go here.
        await forgetDroppedRoles(pool, kube, removed.value, deps.log ?? (() => undefined));
        return c.body(null, 204);
    });

    // Account tokens (decision 144): owners create, change, roll and revoke
    // them, with a session or `oup login` only; owners and developers list
    // them, never with their secrets. A token itself manages none.
    const MANAGE_TOKENS = 'manage Account tokens';
    /** The 403 or 404 for a caller that may not change the Account's tokens, or undefined for an owner with a session. */
    const tokenChangeRefusal = async (c: Context<Env>, accountId: string, ids: readonly string[]) => {
        const managing = await managingMember(c, accountId, ids, MANAGE_TOKENS);
        return managing.refused ?? (managing.caller.role === 'owner' ? undefined : c.json(ownersOnly, 403));
    };
    const tokenNameTaken = (name: string) => ({ error: `an Account token named ${name} exists` });

    app.get('/v1/accounts/:accountId/account-tokens', async (c) => {
        const accountId = c.req.param('accountId');
        if (c.get('identity').kind === 'account-token') {
            return tokenRefused(c, MANAGE_TOKENS);
        }
        return c.get('accountIds').includes(accountId) ? c.json(await listAccountTokens(pool, accountId)) : c.json(notFound, 404);
    });

    app.post('/v1/accounts/:accountId/account-tokens', async (c) => {
        const accountId = c.req.param('accountId');
        const refused = await tokenChangeRefusal(c, accountId, []);
        if (refused !== undefined) {
            return refused;
        }
        const input = tokenInput.safeParse(await body(c));
        if (!input.success) {
            return c.json(invalid(input.error.issues), 400);
        }
        const created = await createAccountToken(pool, accountId, { name: input.data.name, role: input.data.role ?? null, expiresAt: input.data.expiresAt });
        if (!created.ok) {
            return created.error.kind === 'name-taken' ? c.json(tokenNameTaken(created.error.name), 409) : c.json(notFound, 404);
        }
        c.header('location', `/v1/accounts/${accountId}/account-tokens/${created.value.id}`);
        return c.json(created.value, 201);
    });

    app.patch('/v1/accounts/:accountId/account-tokens/:tokenId', async (c) => {
        const { accountId, tokenId } = c.req.param();
        const refused = await tokenChangeRefusal(c, accountId, [tokenId]);
        if (refused !== undefined) {
            return refused;
        }
        const input = tokenPatch.safeParse(await body(c));
        if (!input.success) {
            return c.json(invalid(input.error.issues), 400);
        }
        const changed = await updateAccountToken(pool, accountId, tokenId, input.data);
        if (!changed.ok) {
            return changed.error.kind === 'name-taken' ? c.json(tokenNameTaken(changed.error.name), 409) : c.json(notFound, 404);
        }
        // Without the role, the Postgres roles its grants do not allow are dropped, as for a Member.
        await forgetDroppedRoles(pool, kube, changed.value.dropped, deps.log ?? (() => undefined));
        return c.json(changed.value.value);
    });

    app.post('/v1/accounts/:accountId/account-tokens/:tokenId/roll', async (c) => {
        const { accountId, tokenId } = c.req.param();
        const refused = await tokenChangeRefusal(c, accountId, [tokenId]);
        if (refused !== undefined) {
            return refused;
        }
        const input = tokenRoll.safeParse(await body(c));
        if (!input.success) {
            return c.json(invalid(input.error.issues), 400);
        }
        const rolled = await rollAccountToken(pool, accountId, tokenId, input.data.expiresAt);
        return rolled.ok ? c.json(rolled.value) : c.json(notFound, 404);
    });

    app.delete('/v1/accounts/:accountId/account-tokens/:tokenId', async (c) => {
        const { accountId, tokenId } = c.req.param();
        const refused = await tokenChangeRefusal(c, accountId, [tokenId]);
        if (refused !== undefined) {
            return refused;
        }
        const revoked = await revokeAccountToken(pool, accountId, tokenId);
        if (!revoked.ok) {
            return c.json(notFound, 404);
        }
        await forgetDroppedRoles(pool, kube, revoked.value, deps.log ?? (() => undefined));
        return c.body(null, 204);
    });

    app.put('/v1/accounts/:accountId/account-tokens/:tokenId/grants/:databaseId', async (c) => {
        const { accountId, tokenId, databaseId } = c.req.param();
        const refused = await tokenChangeRefusal(c, accountId, [tokenId, databaseId]);
        if (refused !== undefined) {
            return refused;
        }
        const input = grantInput.safeParse(await body(c));
        if (!input.success) {
            return c.json(invalid(input.error.issues), 400);
        }
        const granted = await setTokenGrant(pool, accountId, tokenId, databaseId, input.data.access);
        if (!granted.ok) {
            return c.json(notFound, 404);
        }
        await forgetDroppedRoles(pool, kube, granted.value.dropped, deps.log ?? (() => undefined));
        return c.json(granted.value.value, granted.value.created ? 201 : 200);
    });

    app.delete('/v1/accounts/:accountId/account-tokens/:tokenId/grants/:databaseId', async (c) => {
        const { accountId, tokenId, databaseId } = c.req.param();
        const refused = await tokenChangeRefusal(c, accountId, [tokenId, databaseId]);
        if (refused !== undefined) {
            return refused;
        }
        const removed = await removeTokenGrant(pool, accountId, tokenId, databaseId);
        if (!removed.ok) {
            return c.json(notFound, 404);
        }
        await forgetDroppedRoles(pool, kube, removed.value, deps.log ?? (() => undefined));
        return c.body(null, 204);
    });

    app.get('/v1/projects', async (c) =>
        c.json(await listProjects(pool, c.get('accountIds'), (await c.get('grants')()).map((grant) => grant.projectId))),
    );

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
    /**
     * The caller's live Project through a role, with `grants` undefined (every
     * Database at every level), or through grants on some of its Databases
     * (decision 139), with those. Only the routes that read a Project or its
     * Databases and open `oup pg proxy` use it; every other route stays with
     * `projectOf` and so needs a role.
     */
    const reachedProjectOf = async (c: Context<Env>, id: string): Promise<{ project: Project; grants?: CallerGrant[] } | undefined> => {
        const project = await projectOf(c.get('accountIds'), id);
        if (project !== undefined) {
            return { project };
        }
        const grants = (await c.get('grants')()).filter((grant) => grant.projectId === id);
        const granted = grants[0] === undefined ? undefined : await projectOf([grants[0].accountId], id);
        return granted === undefined ? undefined : { project: granted, grants };
    };
    /** The Database and the highest level the caller may use there: `owner` with a role, else their grant's (decision 140). */
    const usableDatabaseOf = async (c: Context<Env>, projectId: string, id: string) => {
        const reached = await reachedProjectOf(c, projectId);
        const grant = reached?.grants?.find((candidate) => candidate.databaseId === id);
        if (reached === undefined || !UUID.test(id) || (reached.grants !== undefined && grant === undefined)) {
            return undefined;
        }
        const database = await getDatabase(pool, reached.project.id, id);
        return database === undefined ? undefined : { database, access: grant?.access ?? ('owner' as DatabaseAccess) };
    };

    app.get('/v1/projects/:projectId', async (c) => {
        const reached = await reachedProjectOf(c, c.req.param('projectId'));
        return reached === undefined ? c.json(notFound, 404) : c.json(reached.project);
    });

    app.delete('/v1/projects/:projectId', async (c) => {
        const id = c.req.param('projectId');
        const deleted = UUID.test(id) && (await deleteProject(pool, c.get('accountIds'), id));
        return deleted ? c.body(null, 202) : c.json(notFound, 404);
    });

    app.get('/v1/projects/:projectId/databases', async (c) => {
        const reached = await reachedProjectOf(c, c.req.param('projectId'));
        if (reached === undefined) {
            return c.json(notFound, 404);
        }
        const granted = new Set(reached.grants?.map((grant) => grant.databaseId));
        const databases = (await listDatabases(pool, reached.project.id)).filter((database) => reached.grants === undefined || granted.has(database.id));
        return c.json(await Promise.all(databases.map(details)));
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
        const { homeSite, restoreFrom, autoGrow, maxStorageGb, ...rest } = input.data;
        // A held Account learns that first, not after the storage or backup checks.
        const holds = await holdsOf(pool, project.accountId);
        if (holds.length > 0) {
            return held(c, holds);
        }
        const site = await siteFor(c, homeSite);
        if (!site.ok) {
            return site.error;
        }
        const room = await noRoom(rest, { home: site.value.site, sites: site.value.sites });
        if (room.value !== undefined) {
            return insufficientStorage(c, room.value);
        }
        if (restoreFrom !== undefined) {
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
        // The `app` user's password goes in with the row (decision 155). Without one the
        // Database still runs, with a password of CloudNativePG's as before.
        const id = randomUUID();
        const sealed = await sealNewAppPassword(pool, deps.kek, { id, projectId: project.id });
        if (!sealed.ok) {
            deps.log?.({ msg: "cannot seal a Database's app password; CloudNativePG generates one", project: project.id, error: sealed.error.kind });
        }
        const created = await createDatabase(
            pool,
            project.id,
            {
            ...rest,
            homeSite: site.value.site,
            ...(autoGrow === undefined ? {} : { autoGrow }),
            ...(maxStorageGb === undefined ? {} : { maxStorageGb }),
            ...(restoreFrom === undefined
                ? {}
                : {
                      restoreFrom: {
                          databaseId: restoreFrom.databaseId,
                          ...(restoreFrom.targetTime === undefined ? {} : { targetTime: new Date(restoreFrom.targetTime).toISOString() }),
                      },
                  }),
            },
            sealed.ok ? { id, sealedPassword: sealed.value } : undefined,
        );
        if (!created.ok) {
            return created.error.kind === 'held'
                ? held(c, await holdsOf(pool, project.accountId))
                : c.json({ error: `a Database named ${created.error.name} exists` }, 409);
        }
        if (sealed.ok) {
            // Its Secrets at once, if the Project has its namespace; the secrets pass writes them otherwise.
            syncSecrets(project.id);
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
        const usable = await usableDatabaseOf(c, c.req.param('projectId'), c.req.param('databaseId'));
        return usable === undefined ? c.json(notFound, 404) : c.json(await details(usable.database));
    });

    app.patch('/v1/projects/:projectId/databases/:databaseId', async (c) => {
        const database = await databaseOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('databaseId'));
        if (database === undefined) {
            return c.json(notFound, 404);
        }
        const patch = databasePatch.safeParse(await body(c));
        if (!patch.success) {
            return c.json(invalid(patch.error.issues), 400);
        }
        const { memoryMb, storageGb, autoGrow, maxStorageGb } = patch.data;
        if (storageGb !== undefined && storageGb < database.storageGb) {
            return c.json({ error: `storage only grows: ${database.name} has ${database.storageGb} GB, and a volume cannot shrink` }, 400);
        }
        const maximum = maxStorageGb === undefined ? database.maxStorageGb : maxStorageGb;
        if (maximum !== null && maximum < (storageGb ?? database.storageGb)) {
            return c.json({ error: `maxStorageGb must be at least the storage, ${storageGb ?? database.storageGb} GB` }, 400);
        }
        // Growing costs more, so a held Account may only shrink memory (decision 78).
        const grows = (memoryMb ?? 0) > database.memoryMb || (storageGb ?? 0) > database.storageGb;
        if (grows) {
            const project = await projectOf(c.get('accountIds'), database.projectId);
            const holds = project === undefined ? [] : await holdsOf(pool, project.accountId);
            if (holds.length > 0) {
                return held(c, holds);
            }
        }
        if (grows) {
            const room = await noRoom({ storageGb: storageGb ?? database.storageGb, memoryMb: memoryMb ?? database.memoryMb }, {
                home: database.homeSite,
                sites: await readSites().then((sites) => (sites.ok ? sites.value : undefined)),
                existing: database,
            });
            if (room.value !== undefined) {
                return insufficientStorage(c, room.value);
            }
        }
        const updated = await updateDatabase(pool, database.projectId, database.id, {
            ...(memoryMb === undefined ? {} : { memoryMb }),
            ...(storageGb === undefined ? {} : { storageGb }),
            ...(autoGrow === undefined ? {} : { autoGrow }),
            ...(maxStorageGb === undefined ? {} : { maxStorageGb }),
        });
        return updated === undefined ? c.json(notFound, 404) : c.json(await details(updated));
    });

    app.delete('/v1/projects/:projectId/databases/:databaseId', async (c) => {
        const database = await databaseOf(c.get('accountIds'), c.req.param('projectId'), c.req.param('databaseId'));
        const deleted = database !== undefined && (await deleteDatabase(pool, database.projectId, database.id));
        return deleted ? c.body(null, 202) : c.json(notFound, 404);
    });

    // The caller's own role and the tunnel to it (decision 126, ADR-0005). A
    // POST, since the first ask creates the role: an API key needs
    // openupstream:write at every level, `read` included (decision 64).
    app.post('/v1/projects/:projectId/databases/:databaseId/proxy', async (c) => {
        const usable = await usableDatabaseOf(c, c.req.param('projectId'), c.req.param('databaseId'));
        if (usable === undefined) {
            return c.json(notFound, 404);
        }
        const { database } = usable;
        const input = proxyInput.safeParse((await body(c)) ?? {});
        if (!input.success) {
            return c.json(invalid(input.error.issues), 400);
        }
        if (!accessAllows(usable.access, input.data.access ?? 'read')) {
            return c.json({ error: `your grant on this Database allows ${usable.access} at most` }, 403);
        }
        const identity = c.get('identity');
        // An API key gets roles of its own, which needs madAuth's id for it.
        if (identity.kind !== 'account-token' && identity.scopes !== undefined && identity.apiKeyId === undefined) {
            return c.json({ error: 'madAuth did not name this API key; cannot give it a role' }, 503);
        }
        const access = input.data.access ?? 'read';
        const role = await roleFor(
            pool,
            deps.kek,
            database,
            identity.kind === 'account-token' ? { accountTokenId: identity.tokenId } : { subject: identity.subject, apiKeyId: identity.apiKeyId },
            access,
        );
        if (!role.ok && role.error.kind === 'project-not-found') {
            // The Database went, or the caller was removed from the Account, while the request ran.
            return c.json(notFound, 404);
        }
        if (!role.ok) {
            deps.log?.({ msg: 'cannot open a database role', database: database.id, error: role.error.kind });
            return c.json({ error: 'cannot open the role now' }, 500);
        }
        if (role.value.created) {
            // At once, so the operator finds it with the role; the Secrets pass writes it otherwise.
            const written = await kube.applySecret(roleSecretManifest(database.projectId, role.value));
            if (!written.ok) {
                deps.log?.({ msg: 'cannot write a database role Secret; the secrets pass will', database: database.id, error: written.error });
            }
        }
        const response: DatabaseProxy = {
            access,
            user: role.value.name,
            password: role.value.password,
            database: databaseConnection(database).database,
            tunnelUrl: `wss://${tunnelHostname(database.projectId, deps.customerDomain)}${tunnelPath(database.id, tunnelTargetOf(access))}`,
        };
        return c.json(response, role.value.created ? 201 : 200);
    });

    // Traefik's ForwardAuth asks this before it opens a database tunnel
    // (decision 126): the caller's token, the tunnel host and path it asked
    // for. Any answer but a 2xx goes back to the caller instead, so nothing
    // reaches the Project's namespace without a Member of its Account, or a
    // key of one that may write. The role's password guards the login.
    // Every refusal is a 403, never a 404: Traefik answers 404 itself while
    // a new Project's tunnel route does not exist yet, which `oup` waits
    // out, and a refusal must end its wait.
    app.get('/v1/database-tunnel', async (c) => {
        if (!mayCall(c.get('identity'), 'POST')) {
            return c.json({ error: `this API key lacks the scope ${API_KEY_SCOPES.write}` }, 403);
        }
        const projectId = tunnelProjectOf(c.req.header('x-forwarded-host') ?? '', deps.customerDomain);
        const path = TUNNEL_PATH.exec((c.req.header('x-forwarded-uri') ?? '').split('?')[0] ?? '');
        const refused = { error: 'no such Database tunnel for this caller' };
        if (projectId === undefined || path?.[1] === undefined || (c.req.header('x-forwarded-method') ?? 'GET') !== 'GET') {
            return c.json(refused, 403);
        }
        // The primary only for a role or an `owner` grant (decision 140).
        const usable = await usableDatabaseOf(c, projectId, path[1]);
        return usable === undefined || (path[2] === 'primary' && usable.access !== 'owner') ? c.json(refused, 403) : c.body(null, 204);
    });

    /** The Bucket without its Garage ids, which are ours. */
    const publicBucket = ({ id, projectId, name, createdAt }: BucketRecord): Bucket => ({ id, projectId, name, createdAt });
    /**
     * The Bucket with its key. The secret only for a caller that may write,
     * since the key may write too; Garage keeps it, so it is asked each time.
     */
    const detailsOf = async (bucket: BucketRecord, identity: Caller): Promise<Result<BucketDetails, string>> => {
        const access = {
            endpoint: `https://${bucket.name}.s3.${deps.customerDomain}`,
            region: GARAGE_REGION,
            accessKeyId: bucket.accessKeyId,
        };
        if (!mayCall(identity, 'POST')) {
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
        const ours = [deps.customerDomain, deps.platformDomain, ...(deps.waitlistDomain === undefined ? [] : [deps.waitlistDomain])];
        const website = hostname === deps.waitlistDomain && project.id === deps.websiteProjectId;
        if (isReserved(hostname, ours) && !website) {
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
        const site = await defaultSite();
        if (site === undefined) {
            return services.map((service) => ({ ...service, state: 'unknown' }));
        }
        const rows = (await Promise.all(projectIds.map((projectId) => listServiceRows(pool, site, projectId)))).flat();
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
        const site = await givenSite(c, homeSite);
        if (!site.ok) {
            return site.error;
        }
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
        const site = await givenSite(c, input.data.homeSite);
        if (!site.ok) {
            return site.error;
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
        const site = await defaultSite();
        if (site === undefined) {
            return jobs.map((job) => ({ ...job, state: 'unknown' }));
        }
        const rows = (await Promise.all(projectIds.map((projectId) => listJobRows(pool, site, projectId)))).flat();
        return Promise.all(jobs.map(async (job) => ({ ...job, state: await jobStateFor(job, rows.find((row) => row.job.id === job.id)) })));
    };
    const jobDetails = async (job: Job): Promise<JobDetails> => (await jobsDetails([job]))[0] as JobDetails;
    /** The Job's stored credentials, opened; undefined when it has none. */
    const storedJobAuth = async (job: Job): Promise<RegistryAuth | undefined> =>
        openAuth(job.projectId, jobRegistryAuthName(job.id), await sealedJobRegistryAuth(pool, job.projectId, job.id));

    app.get('/v1/projects/:projectId/usage', async (c) => {
        const project = await projectOf(c.get('accountIds'), c.req.param('projectId'));
        if (project === undefined) {
            return c.json(notFound, 404);
        }
        const [databases, services, jobs, buckets, pods] = await Promise.all([
            listDatabases(pool, project.id),
            listServices(pool, project.id),
            listJobs(pool, project.id),
            listBuckets(pool, project.id),
            kube.listPods(projectNamespace(project.id), projectPods(project.id)),
        ]);
        if (!pods.ok) {
            deps.log?.({ msg: 'usage: cannot list the pods', projectId: project.id, error: pods.error });
            return c.json({ error: 'cannot read the instances now' }, 503);
        }
        const nodes = [...new Set(pods.value.flatMap((pod) => (pod.nodeName === undefined ? [] : [pod.nodeName])))];
        const [nodeSites, measurements, sizes] = await Promise.all([
            Promise.all(nodes.map(async (node) => [node, await kube.nodeSite(node)] as const)),
            deps.prometheus === undefined ? undefined : measure(deps.prometheus, project.id, deps.databaseVolumes ?? 'dedicated'),
            Promise.all(buckets.map(async (bucket) => [bucket.id, await storage.bucketBytes(bucket.bucketId)] as const)),
        ]);
        if (measurements !== undefined && !measurements.ok) {
            deps.log?.({ msg: 'usage: cannot ask Prometheus', projectId: project.id, error: measurements.error });
        }
        const siteOfNode = new Map(nodeSites.map(([node, site]) => [node, site.ok ? siteOf(site.value) : null]));
        const sites = new Map(pods.value.map((pod) => [pod.name, pod.nodeName === undefined ? null : (siteOfNode.get(pod.nodeName) ?? null)]));
        const bucketBytes = new Map(sizes.flatMap(([id, size]) => (size.ok ? [[id, size.value] as const] : [])));
        const measured = measurements?.ok === true ? measurements.value : undefined;
        return c.json(projectUsage(new Date(), measured !== undefined, usageOf({ databases, services, jobs, buckets }, pods.value, sites, measured, bucketBytes)));
    });

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
        const site = await givenSite(c, homeSite);
        if (!site.ok) {
            return site.error;
        }
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
        const site = await givenSite(c, input.data.homeSite);
        if (!site.ok) {
            return site.error;
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
        const site = await defaultSite();
        if (site === undefined) {
            return sitesDown(c);
        }
        const wanted = (await listJobRows(pool, site, job.projectId)).find((row) => row.job.id === job.id);
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
