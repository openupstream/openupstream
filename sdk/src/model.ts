/**
 * The objects of the openupstream API. Terms follow GLOSSARY.md; the control
 * plane's schema (control-plane/migrations) stores exactly these.
 *
 * Ids are UUIDs, timestamps RFC 3339 strings.
 */

export type Id = string;
export type Timestamp = string;

/** Compute Sites, where Databases and Services run. Both are in Germany. */
export const COMPUTE_SITES = ['hetzner-fsn1', 'ovh-lim'] as const;
export type Site = (typeof COMPUTE_SITES)[number];

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
}

/** A person who can sign in to an Account. Sign-in is madAuth's. */
export interface Member {
    id: Id;
    accountId: Id;
    /** The madAuth subject this Member signs in as. */
    authSubject: string;
    email: string;
    createdAt: Timestamp;
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
    createdAt: Timestamp;
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

/** Creates a Database; homeSite defaults to `hetzner-fsn1`. */
export interface DatabaseInput {
    name: string;
    homeSite?: Site;
    memoryMb: number;
    storageGb: number;
}

/**
 * - `provisioning`: being created, or not yet seen by the operator
 * - `ready`: both instances healthy
 * - `degraded`: running, but not every instance is healthy (e.g. during a
 *   failover)
 * - `unknown`: the platform could not check just now
 */
export type DatabaseState = 'provisioning' | 'ready' | 'degraded' | 'unknown';

/**
 * Where the Project's Services reach the Database: through its PgBouncer
 * (transaction pooling), inside the cluster only. The password is never
 * returned; it is given to Services as DATABASE_URL.
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
 * An HTTP container, always on, 1..N replicas (ARCHITECTURE.md,
 * "Containers"). Its image is pinned to a digest whenever it is deployed.
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
    /** The HTTP port the container listens on. */
    port: number;
    /**
     * Where a single replica runs; null: the Home site of the Project's oldest
     * Database, or `hetzner-fsn1`. Two or more replicas run in both Sites.
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
    port: number;
    /** Default 1. */
    replicas?: number;
    memoryMb: number;
    cpuMillicores: number;
    homeSite?: Site;
    registryAuth?: RegistryAuth;
}

/**
 * Changes a Service. A new `image` or `registryAuth` resolves the tag again;
 * `registryAuth: null` removes the credentials, `homeSite: null` the choice.
 */
export interface ServicePatch {
    image?: string;
    port?: number;
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
 * Creates a Route to a Bucket of the same Project. The prefix is stripped:
 * `/docs/a.html` on the Route `/docs` serves the object `a.html`. With
 * `spaFallback`, a path with no object serves `index.html` with status 200;
 * every Route to one Bucket has the same `spaFallback`.
 */
export interface RouteInput {
    pathPrefix: string;
    bucketId: Id;
    spaFallback?: boolean;
}

export const RESOURCE_KINDS = ['database', 'bucket', 'service'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

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
