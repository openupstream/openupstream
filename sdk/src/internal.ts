/**
 * The control plane's internal API, which the operators and the billing
 * service call (ARCHITECTURE.md, "Operators" and "Billing"). Not part of the
 * public API: it is served on its own port, never routed by ingress, and
 * callers authenticate with their Kubernetes ServiceAccount token.
 */
import type { Account, Database, Domain, Id, Member, Project, Route } from './model.js';

/**
 * Kubernetes names, by id (ARCHITECTURE.md, decision 42): the operators
 * create these objects, the control plane reads and deletes them.
 */
export const projectNamespace = (projectId: Id): string => `project-${projectId}`;

/** The Database's CloudNativePG Cluster; also its ObjectStore, ScheduledBackup and backup folder. */
export const clusterName = (database: Pick<Database, 'id'>): string => `db-${database.id}`;

/** Cannot share the Cluster's name, nor `<cluster>-rw`, which the Cluster's own Service takes. */
export const poolerName = (database: Pick<Database, 'id'>): string => `${clusterName(database)}-pooler`;

/** The folder under the backup bucket that holds one Database's base backups and WAL. */
export const backupPrefix = (projectId: Id, databaseId: Id): string =>
    `${projectNamespace(projectId)}/${clusterName({ id: databaseId })}/`;

/** Ids are lowercase UUIDs, as Postgres prints them; usable in DNS names. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Project and Database names, and label values: a DNS label (the schema checks the same). */
export const DNS_LABEL = /^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Audience of the ServiceAccount tokens the operators send. */
export const INTERNAL_API_AUDIENCE = 'openupstream-control-plane';

/** `GET` lists every Database with its Project. */
export const INTERNAL_DATABASES_PATH = '/internal/v1/databases';

/**
 * `GET <path>/<account id>`: the Account with its Holds and Members.
 * `PUT` and `DELETE <path>/<account id>/holds/<reason>`: place or lift a
 * Hold; both answer 204 whether or not the Hold was there. A reason is a
 * DNS label.
 */
export const INTERNAL_ACCOUNTS_PATH = '/internal/v1/accounts';

/** `GET` lists every Domain that has Routes, with its Routes, for the Routes operator. */
export const INTERNAL_ROUTES_PATH = '/internal/v1/routes';

/** The Traefik IngressRoute that serves one Domain, in its Project's namespace. */
export const ingressRouteName = (domainId: Id): string => `domain-${domainId}`;

/**
 * One Domain as the Routes operator needs it: where it lives, its hostname,
 * and its Routes with the name of the Bucket each one serves.
 */
export interface DomainRouting {
    readonly projectId: Id;
    /** For the namespace's labels, which the Databases operator sets too. */
    readonly projectName: string;
    readonly domainId: Id;
    readonly hostname: string;
    /** A default Domain uses the customer domain's wildcard certificate; a custom one gets its own. */
    readonly kind: Domain['kind'];
    readonly routes: readonly (Pick<Route, 'id' | 'pathPrefix'> & { readonly bucketName: string; readonly spaFallback: boolean })[];
}

export interface AccountRecord extends Account {
    readonly members: readonly Pick<Member, 'authSubject' | 'email'>[];
}

export interface DatabaseRow {
    readonly project: Project;
    readonly database: Database;
}

/**
 * The platform's own Account, Project and Databases: the control plane's
 * state (`database`) and madAuth's users (`authDatabase`). The bootstrap
 * creates these Databases once; the control plane seeds these rows at
 * startup, and from then on the operator reconciles them like any
 * customer's. Fixed ids, so bootstrap and control plane agree.
 */
export const PLATFORM = {
    account: {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'openupstream',
        createdAt: '2026-10-17T00:00:00Z',
    },
    project: {
        id: '00000000-0000-4000-8000-000000000002',
        accountId: '00000000-0000-4000-8000-000000000001',
        name: 'platform',
        createdAt: '2026-10-17T00:00:00Z',
    },
    database: {
        id: '00000000-0000-4000-8000-000000000003',
        projectId: '00000000-0000-4000-8000-000000000002',
        name: 'control-plane',
        homeSite: 'hetzner-fsn1',
        memoryMb: 512,
        storageGb: 5,
        createdAt: '2026-10-17T00:00:00Z',
    },
    authDatabase: {
        id: '00000000-0000-4000-8000-000000000004',
        projectId: '00000000-0000-4000-8000-000000000002',
        name: 'auth',
        homeSite: 'hetzner-fsn1',
        memoryMb: 512,
        storageGb: 2,
        createdAt: '2026-10-17T00:00:00Z',
    },
    /** The billing service's state; seeded only where a billing service runs (BILLING_CALLERS). */
    billingDatabase: {
        id: '00000000-0000-4000-8000-000000000005',
        projectId: '00000000-0000-4000-8000-000000000002',
        name: 'billing',
        homeSite: 'hetzner-fsn1',
        memoryMb: 512,
        storageGb: 2,
        createdAt: '2026-10-20T00:00:00Z',
    },
} as const satisfies {
    account: Omit<Account, 'holds'>;
    project: Project;
    database: Database;
    authDatabase: Database;
    billingDatabase: Database;
};

/** The platform's Database rows, as the operator gets them. */
export const PLATFORM_ROWS: readonly DatabaseRow[] = [
    { project: PLATFORM.project, database: PLATFORM.database },
    { project: PLATFORM.project, database: PLATFORM.authDatabase },
];
