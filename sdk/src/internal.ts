/**
 * The control plane's internal API, which the operators and the billing
 * service call (ARCHITECTURE.md, "Operators" and "Billing"). Not part of the
 * public API: it is served on its own port, never routed by ingress, and
 * callers authenticate with their Kubernetes ServiceAccount token.
 */
import type { Account, Database, Domain, Id, Job, Member, Project, Route, Service, Site } from './model.js';

/**
 * Kubernetes names, by id (ARCHITECTURE.md, decision 42): the operators
 * create these objects, the control plane reads and deletes them.
 */
export const projectNamespace = (projectId: Id): string => `project-${projectId}`;

/** The Database's CloudNativePG Cluster; also its ObjectStore, ScheduledBackup and backup folder. */
export const clusterName = (database: Pick<Database, 'id'>): string => `db-${database.id}`;

/** Cannot share the Cluster's name, nor `<cluster>-rw`, which the Cluster's own Service takes. */
export const poolerName = (database: Pick<Database, 'id'>): string => `${clusterName(database)}-pooler`;

/**
 * The Kubernetes Secret in a Project's namespace that holds all its Secrets'
 * values; the control plane writes it, Services and Jobs read it with `envFrom`.
 */
export const PROJECT_SECRETS = 'project-secrets';

/**
 * The `kubernetes.io/dockerconfigjson` Secret in a Project's namespace with
 * the registry credentials of all its Services and Jobs, each under its
 * image's repository; the control plane writes it, every Service and Job
 * names it in `imagePullSecrets`.
 */
export const PROJECT_REGISTRY_AUTH = 'project-registry-auth';

/** The Service's Deployment and Kubernetes Service, in its Project's namespace. */
export const serviceObjectName = (service: Pick<Service, 'id'>): string => `svc-${service.id}`;

/** The Job's CronJob, in its Project's namespace; its runs are Kubernetes Jobs named after it. */
export const jobObjectName = (job: Pick<Job, 'id'>): string => `job-${job.id}`;

/** On a Job's CronJob and its runs: the Job's id, by which the control plane lists the runs. */
export const JOB_ID_LABEL = 'openupstream.io/job-id';

/** On a run the control plane started (a One-off job): `api`. Scheduled runs do not have it. */
export const RUN_TRIGGER_LABEL = 'openupstream.io/trigger';

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

/** `GET` lists every Service with its Project, for the Services operator. */
export const INTERNAL_SERVICES_PATH = '/internal/v1/services';

/** `GET` lists every Job with its Project, for the Jobs operator. */
export const INTERNAL_JOBS_PATH = '/internal/v1/jobs';

/** The Traefik IngressRoute that serves one Domain, in its Project's namespace. */
export const ingressRouteName = (domainId: Id): string => `domain-${domainId}`;

/** A Route as the Routes operator needs it: the Bucket by name, or the Service with its port. */
export type RoutedPath = Pick<Route, 'id' | 'pathPrefix'> &
    (
        | { readonly kind: 'bucket'; readonly bucketName: string; readonly spaFallback: boolean }
        | { readonly kind: 'service'; readonly serviceId: Id; readonly port: number }
    );

/**
 * One Domain as the Routes operator needs it: where it lives, its hostname,
 * and its Routes with what each one serves.
 */
export interface DomainRouting {
    readonly projectId: Id;
    /** For the namespace's labels, which the Databases operator sets too. */
    readonly projectName: string;
    readonly domainId: Id;
    readonly hostname: string;
    /** A default Domain uses the customer domain's wildcard certificate; a custom one gets its own. */
    readonly kind: Domain['kind'];
    readonly routes: readonly RoutedPath[];
}

export interface AccountRecord extends Account {
    readonly members: readonly Pick<Member, 'authSubject' | 'email'>[];
}

/** One Service as the Services operator needs it. */
export interface ServiceRow {
    readonly project: Project;
    readonly service: Pick<Service, 'id' | 'name' | 'image' | 'imageDigest' | 'replicas' | 'memoryMb' | 'cpuMillicores' | 'port'>;
    /** What the Deployment runs: `<registry>/<repository>@<digest>`. */
    readonly pinnedImage: string;
    /** Where a single replica runs: the Service's homeSite, else the Project's oldest Database's, else `hetzner-fsn1`. */
    readonly site: Site;
    /**
     * The version of the Project's Secrets in its Kubernetes Secret: it
     * changes once the control plane has written new values there, never
     * before. The operator puts it on the pod template, so a change rolls the
     * Service and its pods read the new values.
     */
    readonly secretsVersion: string;
}

/** On a Service's Deployment and a Job's CronJob: the spec version it was applied from (serviceSpecVersion, jobSpecVersion). */
export const SPEC_VERSION_ANNOTATION = 'openupstream.io/spec-version';

/**
 * Everything of a Service's row that its Deployment is rendered from. The
 * Services operator writes it on the Deployment; the control plane reports
 * `deploying` until the Deployment carries the version its row asks for,
 * so a change is not `running` before it has been applied and rolled out.
 */
export const serviceSpecVersion = (row: Pick<ServiceRow, 'service' | 'pinnedImage' | 'site' | 'secretsVersion'>): string =>
    [row.pinnedImage, row.service.replicas, row.service.memoryMb, row.service.cpuMillicores, row.service.port, row.site, row.secretsVersion].join('|');

/** One Job as the Jobs operator needs it. */
export interface JobRow {
    readonly project: Project;
    readonly job: Pick<
        Job,
        'id' | 'name' | 'image' | 'imageDigest' | 'command' | 'args' | 'memoryMb' | 'cpuMillicores' | 'timeoutSeconds' | 'schedule' | 'timeZone'
    >;
    /** What its runs start: `<registry>/<repository>@<digest>`. */
    readonly pinnedImage: string;
    /** Where its runs go: the Job's homeSite, else the Project's oldest Database's, else `hetzner-fsn1`. */
    readonly site: Site;
}

/**
 * Everything of a Job's row that its CronJob is rendered from. The Jobs
 * operator writes it on the CronJob; until the CronJob carries the version
 * the row asks for, the Job is `deploying` and no run starts from the old
 * template. The Secrets are not part of it: a run's pod reads them when it
 * starts, so nothing needs to change when they do.
 */
export const jobSpecVersion = (row: Pick<JobRow, 'job' | 'pinnedImage' | 'site'>): string =>
    JSON.stringify([
        row.pinnedImage,
        row.job.command,
        row.job.args,
        row.job.memoryMb,
        row.job.cpuMillicores,
        row.job.timeoutSeconds,
        row.job.schedule,
        row.job.timeZone,
        row.site,
    ]);

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
