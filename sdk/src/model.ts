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

export interface Service {
    id: Id;
    projectId: Id;
    /** DNS label, unique within the Project. */
    name: string;
    /** The image reference as given, from any registry. */
    image: string;
    /** `sha256:…`, pinned when the image is deployed; null before the first deploy. */
    imageDigest: string | null;
    replicas: number;
    memoryMb: number;
    cpuMillicores: number;
    /** The HTTP port the container listens on. */
    port: number;
    createdAt: Timestamp;
}

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
