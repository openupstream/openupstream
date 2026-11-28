/**
 * The objects of the openupstream API. Terms follow GLOSSARY.md; the control
 * plane's schema (control-plane/migrations) stores exactly these.
 *
 * Ids are UUIDs, timestamps RFC 3339 strings.
 */

export type Id = string;
export type Timestamp = string;

/**
 * A Site's id: its nodes' `topology.kubernetes.io/zone` label, so a
 * Kubernetes label value (ADR-0007). Which Sites exist is the
 * installation's: `GET /v1/sites` lists the compute Sites, where Databases,
 * Services and Jobs run.
 */
export type Site = string;
export const SITE_ID = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;

/** A compute Site (`GET /v1/sites`). */
export interface SiteInfo {
    id: Site;
    /** What the installation's admins call it (e.g. `Falkenstein (Hetzner)`); null until they name it. */
    description: string | null;
    /** Whether it is the Home site of what is created without one. */
    default: boolean;
}

/**
 * What can be wrong with the nodes' Site labels (ADR-0008): the rules the
 * install checks, which the control plane checks again while the cluster
 * runs. Each has an alert of its own.
 */
export const SITE_PROBLEMS = [
    'node-without-site',
    'node-neither-compute-nor-quorum',
    'node-compute-and-quorum',
    'site-mixed-compute',
    'site-mixed-default',
    'default-site-missing',
    'default-site-not-unique',
    'default-site-not-compute',
    'compute-sites-below-two',
    'sites-below-three',
] as const;
export type SiteProblemKind = (typeof SITE_PROBLEMS)[number];

/** One thing wrong with the Site labels, and the command that fixes it. */
export interface SiteProblem {
    kind: SiteProblemKind;
    /** The node it is about; null when it is about a Site or the whole cluster. */
    node: string | null;
    /** The Site it is about; null when it is about the whole cluster or a node without one. */
    site: Site | null;
    /** What is wrong, in a sentence. */
    message: string;
    /** The `kubectl` command that fixes it; `<…>` marks what the operator chooses. */
    fix: string;
}

/** A node of the cluster as its labels place it (`GET /v1/admin/nodes`). */
export interface NodeInfo {
    name: string;
    /** Its Site (its zone label); null when it has none. */
    site: Site | null;
    /** Labelled a node of a compute Site. */
    compute: boolean;
    /** Labelled a node of the default Site. */
    default: boolean;
    /** Tainted quorum-only: only etcd, Garage, Loki and the node agents run there. */
    quorumOnly: boolean;
    /** Kubernetes reports it Ready. */
    ready: boolean;
    createdAt: Timestamp;
}

/** A Site as the installation's admins see it: compute or not, with its description (`GET /v1/admin/nodes`). */
export interface SiteDetails extends SiteInfo {
    /** Its nodes are labelled compute: Databases, Services and Jobs run there. */
    compute: boolean;
}

/** A Site's description, set by an admin; null removes it, so the id is shown alone (ADR-0009). */
export interface SiteDescriptionInput {
    description: string | null;
}

/** Every Site and node and what is wrong with the Site labels, for the installation's admins. */
export interface NodesReport {
    /** Every Site that has a node, by id. */
    sites: SiteDetails[];
    nodes: NodeInfo[];
    problems: SiteProblem[];
}

/** The customer: pays, receives one invoice, owns Projects. */
export interface Account {
    id: Id;
    name: string;
    createdAt: Timestamp;
    /**
     * Why the Account may not create Resources now, e.g. `payment-method`;
     * empty when it may. Existing Resources keep running.
     */
    holds: string[];
    /** The caller's role in the Account (`GET /v1/accounts`); null without one. */
    role?: MemberRole | null;
}

/**
 * What a Member may do in the whole Account (decision 138): `owner`
 * everything, the Account's Members included; `developer` every Project and
 * everything in it.
 */
export const MEMBER_ROLES = ['owner', 'developer'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** A person who can sign in to an Account. Sign-in is madAuth's. */
export interface Member {
    id: Id;
    accountId: Id;
    /** The madAuth subject this Member signs in as. */
    authSubject: string;
    email: string;
    /** null: the Member reaches only what their grants give them. */
    role: MemberRole | null;
    /** Their grants, oldest first; they count only while the Member has no role (decision 139). */
    grants: Grant[];
    createdAt: Timestamp;
}

/**
 * Changes a Member's role; only an owner may, with a session or `oup login`,
 * never an API key. null leaves them only their grants: their Postgres roles
 * above what the grants allow are dropped (decision 143).
 */
export interface MemberPatch {
    role: MemberRole | null;
}

/**
 * Access for one Member to one Database at a level (decision 139): they see
 * the Database and its Project's name and open `oup pg proxy` at that level
 * or below (decision 140), nothing else of the Project. A Member with a role
 * needs none.
 */
export interface Grant {
    databaseId: Id;
    databaseName: string;
    projectId: Id;
    projectName: string;
    access: DatabaseAccess;
    createdAt: Timestamp;
}

/** Gives a Member or an Account token a grant, or another level; owners only, never with an API key. */
export interface GrantInput {
    access: DatabaseAccess;
}

/**
 * What an Account token may do in the whole Account (decision 144):
 * `developer`, as a Member with that role; never `owner`, so a token
 * cannot manage the Account.
 */
export const ACCOUNT_TOKEN_ROLES = ['developer'] as const;
export type AccountTokenRole = (typeof ACCOUNT_TOKEN_ROLES)[number];

/** How an Account token's secret starts; `oup` and the SDK send it like an API key (`OUP_API_KEY`). */
export const ACCOUNT_TOKEN_PREFIX = 'oup_tok_';

/** An Account token expires at most this many days after it is created or rolled. */
export const ACCOUNT_TOKEN_MAX_DAYS = 365;

/**
 * A named secret that belongs to the Account, not to a person, for CI, BI
 * tools and scripts outside the platform (decision 144). It has the
 * developer role or grants, and keeps working when the Member who made it
 * leaves. The secret is shown once, when it is created or rolled.
 */
export interface AccountToken {
    id: Id;
    accountId: Id;
    /** DNS label, unique within the Account. */
    name: string;
    /** null: the token reaches only what its grants give. */
    role: AccountTokenRole | null;
    /** Its grants, oldest first; they count only while the token has no role. */
    grants: Grant[];
    expiresAt: Timestamp;
    /** The last request made with it, to the minute; null if none yet. */
    lastUsedAt: Timestamp | null;
    createdAt: Timestamp;
}

/** A new Account token; owners only, with a session or `oup login`. */
export interface AccountTokenInput {
    name: string;
    /** Default null: only its grants, given afterwards. */
    role?: AccountTokenRole | null;
    /** In the future, at most ACCOUNT_TOKEN_MAX_DAYS away. */
    expiresAt: Timestamp;
}

/** Renames an Account token or changes its role; a lost role drops its Postgres roles its grants do not allow. */
export interface AccountTokenPatch {
    name?: string;
    role?: AccountTokenRole | null;
}

/** A new secret for an Account token, with a new expiry; its name, rights and Postgres roles stay. */
export interface AccountTokenRoll {
    /** In the future, at most ACCOUNT_TOKEN_MAX_DAYS away. */
    expiresAt: Timestamp;
}

/** The answer to creating or rolling an Account token: the only time its secret is shown. */
export interface AccountTokenWithSecret extends AccountToken {
    /** `oup_tok_…`. */
    secret: string;
    /** After a roll: until when the previous secret still works (24 hours at most); absent when none does. */
    previousSecretValidUntil?: Timestamp;
}

/** The unit of isolation and lifecycle; deleting it deletes everything in it. */
export interface Project {
    id: Id;
    accountId: Id;
    /** DNS label, unique within the Account. */
    name: string;
    createdAt: Timestamp;
}

/** Postgres always runs with at least this much memory. */
export const DATABASE_MIN_MEMORY_MB = 256;

export interface Database {
    id: Id;
    projectId: Id;
    /** DNS label, unique within the Project. */
    name: string;
    /** Where the primary runs when nothing has failed. */
    homeSite: Site;
    memoryMb: number;
    storageGb: number;
    /**
     * Whether storage grows by itself (decision 111): by half once a volume
     * is 90% used, up to maxStorageGb. False: only resizing grows it.
     */
    autoGrow: boolean;
    /** How far auto-grow may take storageGb; null: no limit but the nodes' free space. */
    maxStorageGb: number | null;
    createdAt: Timestamp;
    /** Set when the Database started as a copy of another one. */
    restoredFrom?: DatabaseRestore;
}

/**
 * Where a restored Database's data comes from (decision 108): another
 * Database of the same Project, live or deleted within the backup retention
 * window, at `targetTime`; without it, the latest point its backups reach.
 */
export interface DatabaseRestore {
    databaseId: Id;
    targetTime?: Timestamp;
}

/** Creates an Account; the caller becomes its first Member. */
export interface AccountInput {
    name: string;
}

/**
 * What an API key may do (madAuth API keys, created by the Member): `read`
 * allows every GET, `write` everything. A Member's own session may do
 * everything.
 */
export const API_KEY_SCOPES = {
    read: 'openupstream:read',
    write: 'openupstream:write',
} as const;

/** Creates a Project in one of the caller's Accounts. */
export interface ProjectInput {
    accountId: Id;
    name: string;
}

/**
 * Creates a Database; homeSite defaults to the default Site (`GET /v1/sites`). With
 * `restoreFrom`, it starts as a copy of that Database instead of empty.
 */
export interface DatabaseInput {
    name: string;
    homeSite?: Site;
    memoryMb: number;
    storageGb: number;
    /** Default true. */
    autoGrow?: boolean;
    /** Default null: no limit. At least storageGb. */
    maxStorageGb?: number | null;
    restoreFrom?: DatabaseRestore;
}

/**
 * Resizes a Database (decision 110). Storage only grows: a volume cannot
 * shrink. A new memory size restarts the instances one after the other,
 * the standby first, then a switchover (writes pause for seconds).
 */
export interface DatabasePatch {
    memoryMb?: number;
    storageGb?: number;
    autoGrow?: boolean;
    /** null removes the limit. */
    maxStorageGb?: number | null;
}

/**
 * - `provisioning`: being created, or not yet seen by the operator
 * - `resizing`: its Cluster does not have the size the Database asks for yet
 * - `ready`: both instances healthy
 * - `degraded`: running, but not every instance is healthy (e.g. during a
 *   failover)
 * - `unknown`: the platform could not check just now
 */
export type DatabaseState = 'provisioning' | 'resizing' | 'ready' | 'degraded' | 'unknown';

/**
 * Where the Project's Services and Jobs reach the Database: through its
 * PgBouncer (transaction pooling), inside the cluster only. The password is
 * never returned; every Service and Job of the Project gets the whole URL as
 * `DATABASE_URL_<NAME>` (the name upper-cased, `-` as `_`), and the oldest
 * Database's also as `DATABASE_URL` (decision 97).
 */
export interface DatabaseConnection {
    host: string;
    port: number;
    database: string;
    user: string;
}

/** A Database as the API returns it. */
export interface DatabaseDetails extends Database {
    state: DatabaseState;
    connection: DatabaseConnection;
}

/**
 * How much a caller's own Postgres role may do through `oup pg proxy`
 * (decision 126, ADR-0005): read every table; also write rows; or act as
 * `app`, the role the Project's Services connect as, so migrations work.
 */
export const DATABASE_ACCESS_LEVELS = ['read', 'write', 'owner'] as const;
export type DatabaseAccess = (typeof DATABASE_ACCESS_LEVELS)[number];

/** Asks for the caller's role at a level; `read` when none is given. */
export interface DatabaseProxyInput {
    access?: DatabaseAccess;
}

/**
 * The caller's own role for a Database at one level, and the tunnel that
 * reaches it: `oup pg proxy` carries local connections through `tunnelUrl`
 * (a WebSocket, with the caller's token) and the client logs in as `user`
 * with `password`. The same role and password every time it is asked.
 */
export interface DatabaseProxy {
    access: DatabaseAccess;
    user: string;
    password: string;
    database: string;
    tunnelUrl: string;
}

/**
 * A Bucket's name: a hostname label of 3 to 63 lowercase letters, digits
 * and hyphens, neither starting nor ending with a hyphen.
 */
export const BUCKET_NAME = /^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$/;

export interface Bucket {
    id: Id;
    projectId: Id;
    /** Globally unique: it is the hostname `<name>.s3.<customer domain>`. */
    name: string;
    createdAt: Timestamp;
}

/** Creates a Bucket; the name must not be taken in any Project. */
export interface BucketInput {
    name: string;
}

/**
 * How to reach a Bucket with any S3 client: virtual-hosted style only, at
 * `endpoint` (the Bucket's own hostname), with the Bucket's key. The key
 * reads and writes this Bucket and no other.
 */
export interface BucketAccess {
    /** `https://<name>.s3.<customer domain>`. */
    endpoint: string;
    /** What S3 clients sign requests with; Garage accepts only this one. */
    region: string;
    accessKeyId: string;
    /** Left out for an API key with only `openupstream:read`: the key itself may write. */
    secretAccessKey?: string;
}

/** A Bucket as the API returns it. The list leaves out `access`. */
export interface BucketDetails extends Bucket {
    access: BucketAccess;
}

/**
 * A container image from any registry, as given: `nginx:1.27`,
 * `ghcr.io/acme/api:v3`, `registry.example.com:5000/team/app@sha256:…`.
 * A reference without a tag means `latest`.
 */
export const IMAGE_REFERENCE_MAX_LENGTH = 512;

/**
 * Credentials for a private registry: write-only, stored encrypted with the
 * Project's Secrets and never returned. The registry is the image's.
 */
export interface RegistryAuth {
    username: string;
    password: string;
}

/** Limits of a Service, checked by the API. */
export const SERVICE_LIMITS = {
    maxReplicas: 10,
    minMemoryMb: 64,
    maxMemoryMb: 16384,
    minCpuMillicores: 50,
    maxCpuMillicores: 8000,
} as const;

/**
 * A container, always on, 1..N replicas (ARCHITECTURE.md, "Containers"):
 * an HTTP server, or a worker without a port. Its image is pinned to a
 * digest whenever it is deployed.
 */
export interface Service {
    id: Id;
    projectId: Id;
    /** DNS label, unique within the Project. */
    name: string;
    /** The image reference as given, from any registry. */
    image: string;
    /** `sha256:…`, the digest the tag resolved to when the Service was last deployed. */
    imageDigest: string;
    /** When the tag was last resolved: at creation, on a change of image, and on every deploy. */
    deployedAt: Timestamp;
    replicas: number;
    memoryMb: number;
    cpuMillicores: number;
    /**
     * The HTTP port the container listens on; null: a worker, which no Route
     * can serve, gets no in-cluster address and counts as ready once it runs
     * (decision 98).
     */
    port: number | null;
    /**
     * Where a single replica runs; null: the Home site of the Project's oldest
     * Database, or the default Site. Two or more replicas spread over the compute Sites.
     */
    homeSite: Site | null;
    /** Whether the image is pulled with registry credentials. */
    registryAuth: boolean;
    createdAt: Timestamp;
}

/** Creates a Service; the tag is resolved to a digest while the request waits. */
export interface ServiceInput {
    name: string;
    image: string;
    /** Left out: a worker without a port. */
    port?: number;
    /** Default 1. */
    replicas?: number;
    memoryMb: number;
    cpuMillicores: number;
    homeSite?: Site;
    registryAuth?: RegistryAuth;
}

/**
 * Changes a Service. A new `image` or `registryAuth` resolves the tag again;
 * `registryAuth: null` removes the credentials, `homeSite: null` the choice,
 * `port: null` the port (refused while a Route serves the Service).
 */
export interface ServicePatch {
    image?: string;
    port?: number | null;
    replicas?: number;
    memoryMb?: number;
    cpuMillicores?: number;
    homeSite?: Site | null;
    registryAuth?: RegistryAuth | null;
}

/**
 * Read live from its Deployment: `deploying` until the first replica is
 * up and while a new version rolls out, `running` with every replica
 * available, `degraded` with some, `unknown` when Kubernetes cannot be asked.
 */
export type ServiceState = 'deploying' | 'running' | 'degraded' | 'unknown';

/** A Service as the API returns it. */
export interface ServiceDetails extends Service {
    state: ServiceState;
}

/** Limits of a Job, checked by the API; memory and CPU as for a Service. */
export const JOB_LIMITS = {
    minMemoryMb: SERVICE_LIMITS.minMemoryMb,
    maxMemoryMb: SERVICE_LIMITS.maxMemoryMb,
    minCpuMillicores: SERVICE_LIMITS.minCpuMillicores,
    maxCpuMillicores: SERVICE_LIMITS.maxCpuMillicores,
    defaultTimeoutSeconds: 3600,
    maxTimeoutSeconds: 86400,
    /** Entries of `command` and of `args`, and their bytes (UTF-8) together, which go into a Kubernetes annotation. */
    maxArgs: 256,
    maxArgsTotalBytes: 16 * 1024,
} as const;

/**
 * A container image run to completion (ARCHITECTURE.md, "Containers"): a
 * Cron job when it has a `schedule`, and started as a One-off job through
 * the API whether or not it has one. Its image is pinned to a digest
 * whenever it is deployed; every run starts that digest.
 */
export interface Job {
    id: Id;
    projectId: Id;
    /** DNS label, unique within the Project. */
    name: string;
    /** The image reference as given, from any registry. */
    image: string;
    /** `sha256:…`, the digest the tag resolved to when the Job was last deployed. */
    imageDigest: string;
    /** When the tag was last resolved: at creation, on a change of image, and on every deploy. */
    deployedAt: Timestamp;
    /** Replaces the image's entrypoint; null: the image's. */
    command: string[] | null;
    /** Replaces the image's command (its CMD); null: the image's. A run may replace it again. */
    args: string[] | null;
    memoryMb: number;
    cpuMillicores: number;
    /** A run still going after this long is stopped and failed. */
    timeoutSeconds: number;
    /**
     * Five-field cron expression (`*\/15 * * * *`) or `@hourly`, `@daily`,
     * `@weekly`, `@monthly`, `@yearly`; null: started only through the API.
     * A run that is due while the previous one still runs is skipped.
     */
    schedule: string | null;
    /** IANA time zone the schedule is read in, e.g. `Europe/Berlin`; null: UTC. */
    timeZone: string | null;
    /** Where its runs go; null: the Home site of the Project's oldest Database, or the default Site. */
    homeSite: Site | null;
    /** Whether the image is pulled with registry credentials. */
    registryAuth: boolean;
    createdAt: Timestamp;
}

/** Creates a Job; the tag is resolved to a digest while the request waits. */
export interface JobInput {
    name: string;
    image: string;
    command?: string[];
    args?: string[];
    memoryMb: number;
    cpuMillicores: number;
    /** Default JOB_LIMITS.defaultTimeoutSeconds. */
    timeoutSeconds?: number;
    schedule?: string;
    timeZone?: string;
    homeSite?: Site;
    registryAuth?: RegistryAuth;
}

/**
 * Changes a Job. A new `image` or `registryAuth` resolves the tag again;
 * null removes a `command`, `args`, `schedule`, `timeZone`, `homeSite` or
 * the registry credentials.
 */
export interface JobPatch {
    image?: string;
    command?: string[] | null;
    args?: string[] | null;
    memoryMb?: number;
    cpuMillicores?: number;
    timeoutSeconds?: number;
    schedule?: string | null;
    timeZone?: string | null;
    homeSite?: Site | null;
    registryAuth?: RegistryAuth | null;
}

/**
 * Read live from its CronJob: `deploying` until the Jobs operator has
 * applied the Job as it is now, `ready` once it has (runs can start),
 * `unknown` when Kubernetes cannot be asked.
 */
export type JobState = 'deploying' | 'ready' | 'unknown';

/** A Job as the API returns it. */
export interface JobDetails extends Job {
    state: JobState;
}

/**
 * Read live from its Kubernetes Job: `pending` until its container runs
 * (e.g. while the image is pulled), `running`, then `succeeded` (exit 0) or
 * `failed` (another exit code, or stopped at the timeout).
 */
export type JobRunState = 'pending' | 'running' | 'succeeded' | 'failed';

/**
 * One run of a Job, scheduled or started through the API. Kept for 24 hours
 * after it finished; a Cron job keeps at most its last 3 successful and 3
 * failed scheduled runs.
 */
export interface JobRun {
    /** Unique within the Project; the name of its Kubernetes Job. */
    id: string;
    jobId: Id;
    /** `schedule` for a Cron job's run, `api` for a One-off job. */
    trigger: 'schedule' | 'api';
    state: JobRunState;
    /**
     * Why it failed, as Kubernetes says: `BackoffLimitExceeded` (it exited
     * with an error), `DeadlineExceeded` (stopped at the timeout); null
     * otherwise.
     */
    reason: string | null;
    createdAt: Timestamp;
    startedAt: Timestamp | null;
    finishedAt: Timestamp | null;
}

/**
 * Starts a One-off job. `args` replaces the Job's args for this run; `env`
 * adds variables to it, over Secrets of the same name. Together with the
 * Job's command and args at most JOB_LIMITS.maxArgsTotalBytes.
 */
export interface JobRunInput {
    args?: string[];
    env?: Record<string, string>;
}

/**
 * One line of a Service's or a run's output, as the log stream sends it
 * (ARCHITECTURE.md, "Observability and customer logs"): a live tail only,
 * nothing is retained (decision 21).
 */
export interface LogEntry {
    /** The pod (replica or run) it came from. */
    pod: string;
    /** The Site the pod runs in; null when Kubernetes does not say. */
    site: Site | null;
    /** When the container wrote it, as Kubernetes recorded it (RFC 3339, nanoseconds). */
    time: string;
    /** The line, without its line break. */
    line: string;
    /** From the container before its last restart (a crash): what it wrote before it died. */
    previous: boolean;
}

/** Limits of the log stream, checked by the API. */
export const LOG_LIMITS = {
    /** Lines per container sent first, when `tail` is not given. */
    defaultTailLines: 100,
    maxTailLines: 10_000,
    /** A followed stream ends after this long; the client asks again to go on. */
    maxFollowSeconds: 3600,
    /** Followed streams open at once per Account, on one control-plane replica; more answer 429. */
    maxFollowsPerAccount: 10,
    /** A followed stream sends an empty line this often, so a client and the proxies between see it is alive. */
    heartbeatSeconds: 30,
} as const;

/**
 * What to read: `tail` lines per container first; with `follow`, then new
 * lines as they are written, also from replicas that start while it runs,
 * until LOG_LIMITS.maxFollowSeconds have passed or every pod is gone.
 * `tail` 0 sends only what is written from now on. Empty lines in the
 * stream are heartbeats, not entries.
 */
export interface LogQuery {
    tail?: number;
    follow?: boolean;
}

/** A Secret's name is an environment variable name (the schema checks the same). */
export const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;

/**
 * At most this many bytes (UTF-8) per value, and all of a Project's values
 * together at most SECRETS_MAX_TOTAL_BYTES: they go into one Kubernetes
 * Secret (1 MiB at most) and into every container's environment.
 */
export const SECRET_VALUE_MAX_BYTES = 64 * 1024;
export const SECRETS_MAX_TOTAL_BYTES = 512 * 1024;

/**
 * A Secret's value is write-only: the API accepts it and hands it to the
 * Project's Services and jobs as an environment variable, but never returns it.
 */
export interface Secret {
    id: Id;
    projectId: Id;
    /** Environment variable name, unique within the Project. */
    name: string;
    createdAt: Timestamp;
    updatedAt: Timestamp;
}

export interface SecretInput {
    name: string;
    value: string;
}

/**
 * Where `oup login` signs in (`GET /v1/login`, no token needed): madAuth's
 * issuer and the CLI's client ID there, for the device authorization grant.
 */
export interface CliLogin {
    issuer: string;
    clientId: string;
}

/** The TXT record that proves an Account owns a custom domain. */
export interface TxtRecord {
    name: string;
    value: string;
}

export type DomainVerification =
    | { state: 'pending'; txtRecord: TxtRecord }
    | { state: 'verified'; verifiedAt: Timestamp };

interface DomainBase {
    id: Id;
    projectId: Id;
    /** Lowercase hostname. Only one verified Domain per hostname exists. */
    hostname: string;
    createdAt: Timestamp;
}

/** The Project's hostname under the platform's customer domain; always routed. */
export interface DefaultDomain extends DomainBase {
    kind: 'default';
}

/**
 * A hostname the Account claims. Routed only once verified; any number of
 * Projects can hold a pending claim, the first proof wins.
 */
export interface CustomDomain extends DomainBase {
    kind: 'custom';
    verification: DomainVerification;
}

export type Domain = DefaultDomain | CustomDomain;

/** Where the TXT ownership proof for `hostname` has to be published. */
export function txtRecordName(hostname: string): string {
    return `_openupstream.${hostname}`;
}

/**
 * A custom domain's hostname: lowercase labels of letters, digits and
 * hyphens, at least two of them, at most 253 characters (the schema checks
 * the same).
 */
export const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Claims a custom domain for a Project. It is routed once its TXT record
 * (`verification.txtRecord`) is published and verified; point the hostname
 * at `ingress.<customer domain>` with a CNAME for traffic and its
 * certificate, before adding the first Route: its certificate is requested
 * then, and a failed attempt is retried only after an hour.
 */
export interface CustomDomainInput {
    hostname: string;
}

/** A Route's path prefix: `/` or `/segment[/segment…]`, no trailing slash (the schema checks the same). */
export const PATH_PREFIX = /^(\/|(\/[A-Za-z0-9._~-]+)+)$/;

export type RouteTarget =
    | { kind: 'bucket'; bucketId: Id; spaFallback: boolean }
    | { kind: 'service'; serviceId: Id };

/**
 * One entry under a Domain: everything below `pathPrefix` goes to a Bucket or
 * a Service of the Domain's Project.
 */
export interface Route {
    id: Id;
    domainId: Id;
    /** `/` or `/segment[/segment…]`, no trailing slash. Unique per Domain. */
    pathPrefix: string;
    target: RouteTarget;
    createdAt: Timestamp;
}

/**
 * Creates a Route to a Bucket or a Service of the same Project. For a
 * Bucket the prefix is stripped: `/docs/a.html` on the Route `/docs` serves
 * the object `a.html`. With `spaFallback`, a path with no object serves
 * `index.html` with status 200; every Route to one Bucket has the same
 * `spaFallback`. A Service gets the path unchanged.
 */
export type RouteInput =
    | {
          pathPrefix: string;
          bucketId: Id;
          spaFallback?: boolean;
      }
    | {
          pathPrefix: string;
          /** The Service gets the request with its path as it came, prefix included. */
          serviceId: Id;
      };

export const RESOURCE_KINDS = ['database', 'bucket', 'service', 'job'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/**
 * One running copy of a Resource: an instance or a PgBouncer of a Database,
 * a replica of a Service, a run of a Job.
 */
export type InstanceRole = 'database' | 'pooler' | 'replica' | 'run';

/**
 * - `starting`: scheduled or being scheduled, not all containers up yet
 * - `running`: up
 * - `restarting`: a container exited and is being started again
 * - `stopping`: being removed
 * - `succeeded`, `failed`: a Job run that ended
 */
export type InstanceState = 'starting' | 'running' | 'restarting' | 'stopping' | 'succeeded' | 'failed';

export interface Instance {
    /** Unique within its Resource: `1`, `pooler-…`, a replica's suffix, a run's id. */
    name: string;
    role: InstanceRole;
    /** null: not placed yet. */
    site: Site | null;
    state: InstanceState;
    /** How often its containers were started again. */
    restarts: number;
    startedAt: Timestamp | null;
    /** The last two minutes' average; null: not measured. */
    cpuMillicores: number | null;
    /** Memory in use now; null: not measured. */
    memoryBytes: number | null;
    /** A Database instance's disk in use; null: not measured or not a Database instance. */
    storageBytes: number | null;
}

/** What a Resource uses now of what it was given; null: not measured, or nothing was set. */
export interface Measured {
    used: number | null;
    allocated: number | null;
}

/**
 * A Resource's current use (ARCHITECTURE.md, decision 124): the sum over
 * its instances for CPU and memory (a Database's memory: its Postgres
 * instances only, as only they have its size); for a Database's storage
 * its fullest instance, since each holds the same data; for a Bucket its
 * objects' bytes.
 * Not what is billed: usage events are (`UsageEvent`).
 */
export interface ResourceUsage {
    kind: ResourceKind;
    id: Id;
    name: string;
    cpuMillicores: Measured;
    memoryBytes: Measured;
    storageBytes: Measured;
    instances: Instance[];
}

export interface ProjectUsage {
    measuredAt: Timestamp;
    /** false: the installation has no Prometheus, or it did not answer; then only Buckets have `used`. */
    measured: boolean;
    resources: ResourceUsage[];
}

export const USAGE_UNITS = ['cpu_seconds', 'memory_gb_hours', 'storage_gb_hours', 'egress_gb'] as const;
export type UsageUnit = (typeof USAGE_UNITS)[number];

/** A Resource consumed `quantity` of `unit` between `intervalStart` and `intervalEnd`. */
export interface UsageEvent {
    id: string;
    accountId: Id;
    projectId: Id;
    resource: { kind: ResourceKind; id: Id };
    unit: UsageUnit;
    quantity: number;
    intervalStart: Timestamp;
    intervalEnd: Timestamp;
    recordedAt: Timestamp;
}
