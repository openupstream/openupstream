/**
 * Database → Kubernetes objects (ARCHITECTURE.md, "Postgres" and "Backups").
 *
 * One Database becomes four objects in its Project's namespace:
 *
 * - a CloudNativePG `Cluster` with two instances: the primary in the Home
 *   site, the standby in another compute Site (ADR-0007; one instance, no
 *   standby, on a single-node dev cluster: decision 112);
 * - a PgBouncer `Pooler` of type `rw`, so it follows the primary;
 * - a Barman Cloud `ObjectStore` on Hetzner Object Storage NBG1, the WAL
 *   archive and base backup target;
 * - a `ScheduledBackup` taking base backups into it.
 *
 * The Cluster also carries the callers' own roles (decision 126, ADR-0005),
 * which CloudNativePG creates with the password from each role's Secret;
 * the control plane writes those Secrets.
 *
 * Pure: no I/O. Invalid input is returned as errors, never thrown.
 */
import {
    SITE_ID,
    DATABASE_MIN_MEMORY_MB,
    type Database,
    type DatabaseAccess,
    type DatabaseRoleRow,
    type Project,
    type Site,
    clusterName,
    databaseAppVerifierSecret,
    databaseCpuMillicores,
    databaseRoleName,
    databaseRoleSecret,
    poolerName,
    readPoolerName,
} from '@openupstream/sdk';
import type { Cluster, ObjectStore, Pooler, ScheduledBackup } from '../generated/index.js';
import {
    DNS_LABEL,
    LABELS,
    MANAGED_BY,
    type Manifest,
    type ObjectMeta,
    UUID,
    ZONE_LABEL,
    projectNamespace,
    requireComputeSite,
} from '../kubernetes.js';
import { type Result, err, ok } from '../result.js';

export const BARMAN_CLOUD_PLUGIN = 'barman-cloud.cloudnative-pg.io';

/** Hetzner Object Storage in Nuremberg, where no Database instance runs. */
export const BACKUP_ENDPOINT = 'https://nbg1.your-objectstorage.com';

/** The keys of the backup credentials Secret. */
export const BACKUP_CREDENTIAL_KEYS = { accessKeyId: 'ACCESS_KEY_ID', secretAccessKey: 'ACCESS_SECRET_KEY' } as const;

export const DATABASE_INSTANCES = 2;
export const POOLER_INSTANCES = 2;

/**
 * How the cluster is laid out (ARCHITECTURE.md, decision 112): one node per
 * Site, or a single node standing in for all of them, for development only.
 */
export type ClusterLayout = 'multi-node' | 'single-node';

/** Instances of a Database's Cluster and of its Pooler: one per compute Site, or one. */
export const instancesFor = (layout: ClusterLayout | undefined): { database: number; pooler: number } =>
    layout === 'single-node' ? { database: 1, pooler: 1 } : { database: DATABASE_INSTANCES, pooler: POOLER_INSTANCES };

/**
 * A primary in a dark Site sends no TCP reset, so without these PgBouncer
 * keeps its connections to it until server_idle_timeout (10 minutes) and
 * writes stall long after the failover (measured 2026-10-17). Keepalives
 * drop an idle dead connection after about 25 s, tcp_user_timeout one with
 * unacknowledged data after 10 s.
 */
export const POOLER_DEAD_SERVER_DETECTION = {
    tcp_keepalive: '1',
    tcp_keepidle: '10',
    tcp_keepintvl: '5',
    tcp_keepcnt: '3',
    tcp_user_timeout: '10000',
    server_connect_timeout: '5',
} as const;

/**
 * One failed login to Postgres (the old primary going down in a restart)
 * makes PgBouncer refuse every client for server_login_retry, 15 s by
 * default. At 1 s a memory resize paused writes for 12 s instead of 16 s
 * (dev cluster, 2026-11-15).
 */
export const POOLER_LOGIN_RETRY = { server_login_retry: '1' } as const;

/**
 * How a rolling restart (a new memory size, a new image) treats the
 * primary (decision 110): restarted in place, after the standby, so it
 * stays in its Home site; its smart shutdown waits at most 30 s for
 * PgBouncer's connections, which never close by themselves, instead of
 * CloudNativePG's 180 s. Writes keep flowing during that wait; a resize
 * took 1.5 instead of 4 minutes, with one pause of 12 s.
 */
export const PRIMARY_RESTART = { primaryUpdateMethod: 'restart', smartShutdownTimeout: 30 } as const;

/**
 * A grow of memory, and of the CPU share that follows it, resizes the
 * running pods (decision 152): no restart, no switchover. CloudNativePG
 * recreates them as before where Kubernetes cannot resize in place, a
 * lower memory limit among it.
 */
export const RESIZE_IN_PLACE = { resourcesUpdateStrategy: 'inPlace' } as const;

/** The application database and its owner, as CloudNativePG names them. */
const APP_DATABASE = 'app';

/**
 * Run once in the application database when a Cluster is created.
 * CloudNativePG 1.31 no longer lets every role connect to it, and a `read`
 * or `write` role (ROLE_GRANTS) neither owns it nor inherits from its
 * owner, so the predefined roles they are members of get CONNECT.
 */
export const POST_INIT_SQL = ['CREATE EXTENSION IF NOT EXISTS vector', `GRANT CONNECT ON DATABASE ${APP_DATABASE} TO pg_read_all_data, pg_write_all_data`] as const;

/** What a Database's Cluster asks for now, read from Kubernetes; a field it does not state, or states in another form, is absent. */
export interface LiveCluster {
    readonly memoryMb?: number;
    readonly sharedBuffersMb?: number;
}

const numberIn = (value: unknown, unit: string): number | undefined => {
    const match = typeof value === 'string' ? new RegExp(`^(\\d+)${unit}$`).exec(value) : null;
    return match === null ? undefined : Number(match[1]);
};

/** The fields of a Cluster, as this module writes them, that the next one depends on. */
export const liveClusterOf = (cluster: Readonly<Record<string, unknown>>): LiveCluster => {
    const spec = cluster['spec'] as Cluster['spec'] | undefined;
    const memoryMb = numberIn(spec?.resources?.limits?.['memory'], 'Mi');
    const sharedBuffersMb = numberIn(spec?.postgresql?.parameters?.['shared_buffers'], 'MB');
    return {
        ...(memoryMb === undefined ? {} : { memoryMb }),
        ...(sharedBuffersMb === undefined ? {} : { sharedBuffersMb }),
    };
};

/**
 * `shared_buffers` is a quarter of the memory, but Postgres takes a new
 * value only with a restart, which a grow in place must not cause (decision
 * 152). So a running Cluster keeps its value, and gets the quarter of its
 * memory when its instances restart anyway, for less memory. Not with a new
 * image, which restarts them too: CloudNativePG refuses an image and a
 * configuration change in one update where the primary is switched over,
 * and it is not tried where it is restarted, as here. Never more than the
 * quarter, so a value that is too large is corrected.
 */
export const sharedBuffersMbFor = (database: Pick<Database, 'memoryMb'>, live?: LiveCluster): number => {
    const quarter = Math.floor(database.memoryMb / 4);
    if (live?.memoryMb === undefined || live.sharedBuffersMb === undefined) {
        return quarter;
    }
    return database.memoryMb < live.memoryMb ? quarter : Math.min(live.sharedBuffersMb, quarter);
};

/**
 * What a caller's role is granted at each level (decision 126): Postgres's
 * predefined roles for reading and writing every table, or membership in
 * `app`. An `owner` role also sets `app` as its own default role, through
 * `oup`; nothing here can, since CloudNativePG runs no SQL after bootstrap.
 */
export const ROLE_GRANTS: Readonly<Record<DatabaseAccess, readonly string[]>> = {
    read: ['pg_read_all_data'],
    write: ['pg_read_all_data', 'pg_write_all_data'],
    owner: ['app'],
};

/** An `owner` role's connections go to the primary past the Pooler, each a Postgres backend: at most this many at once. */
export const OWNER_CONNECTION_LIMIT = 5;

/**
 * A caller's role as CloudNativePG manages it: logs in with its Secret's
 * password, inherits its grants. A dropped one (decision 143) is only
 * named, `ensure: absent`, with no Secret, which the control plane deleted.
 */
export const managedRoleFor = (role: DatabaseRoleRow) =>
    role.dropped === true
        ? { name: databaseRoleName(role), comment: `openupstream ${role.access} role ${role.id}, dropped`, ensure: 'absent' as const }
        : presentRole(role);

const presentRole = (role: DatabaseRoleRow) => ({
    name: databaseRoleName(role),
    comment: `openupstream ${role.access} role ${role.id}`,
    ensure: 'present' as const,
    login: true,
    inherit: true,
    inRoles: [...ROLE_GRANTS[role.access]],
    passwordSecret: { name: databaseRoleSecret(role) },
    connectionLimit: role.access === 'owner' ? OWNER_CONNECTION_LIMIT : -1,
});

/** A cluster's backup folder: what `backup.prefix` must look like (decision 149). */
export const CLUSTER_PREFIX = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * What is wrong with a DatabaseConfig read from JSON, or undefined. Without a
 * prefix every cluster would archive into the same folders again.
 */
export function databaseConfigProblem(config: Partial<DatabaseConfig>): string | undefined {
    return CLUSTER_PREFIX.test(config.backup?.prefix ?? '')
        ? undefined
        : 'backup.prefix must be the cluster id (lowercase letters, digits, dashes)';
}

/** Platform settings that are the same for every Database. */
export interface DatabaseConfig {
    /** Our Postgres image (`images/postgres`), pinned by digest. */
    readonly postgresImage: string;
    /** The TopoLVM StorageClass on the compute Sites' NVMe. */
    readonly storageClass: string;
    readonly backup: {
        /** Bucket in the separate Hetzner project for backups. */
        readonly bucket: string;
        /**
         * This cluster's folder in the bucket, generated once per install
         * (decision 149), so clusters sharing the bucket, or installed again,
         * never find each other's archives.
         */
        readonly prefix: string;
        /**
         * Secret in the Project's namespace with that project's S3
         * credentials under BACKUP_CREDENTIAL_KEYS.
         */
        readonly credentialsSecret: string;
        /** Point-in-time recovery window, e.g. `30d`. */
        readonly retention: string;
        /** CloudNativePG cron with a leading seconds field, e.g. `0 0 3 * * *`. */
        readonly schedule: string;
    };
    /** Absent: `multi-node`. */
    readonly layout?: ClusterLayout;
}

export type ClusterManifest = Manifest<Cluster, 'postgresql.cnpg.io/v1', 'Cluster'>;
export type PoolerManifest = Manifest<Pooler, 'postgresql.cnpg.io/v1', 'Pooler'>;
export type ObjectStoreManifest = Manifest<ObjectStore, 'barmancloud.cnpg.io/v1', 'ObjectStore'>;
export type ScheduledBackupManifest = Manifest<ScheduledBackup, 'postgresql.cnpg.io/v1', 'ScheduledBackup'>;

export interface DatabaseManifests {
    readonly objectStore: ObjectStoreManifest;
    readonly cluster: ClusterManifest;
    readonly pooler: PoolerManifest;
    /**
     * The Pooler to the standby, for the read URL (decision 157); absent
     * where a Database has no standby (a single node).
     */
    readonly readPooler?: PoolerManifest;
    readonly scheduledBackup: ScheduledBackupManifest;
}

export type DatabaseManifestError =
    | { readonly kind: 'invalid-id'; readonly field: 'project.id' | 'database.id'; readonly value: string }
    | { readonly kind: 'invalid-name'; readonly field: 'project.name' | 'database.name'; readonly value: string }
    | { readonly kind: 'project-mismatch'; readonly projectId: string; readonly databaseProjectId: string }
    | { readonly kind: 'invalid-site'; readonly value: string }
    | { readonly kind: 'invalid-memory'; readonly memoryMb: number }
    | { readonly kind: 'memory-below-floor'; readonly memoryMb: number; readonly minimumMb: number }
    | { readonly kind: 'invalid-storage'; readonly storageGb: number }
    | { readonly kind: 'invalid-role'; readonly id: string; readonly access: string };

export { clusterName, poolerName, readPoolerName } from '@openupstream/sdk';

/**
 * Rows come from the database as strings; the type alone does not guarantee
 * this. Which Sites are compute Sites is the nodes' (ADR-0007): the control
 * plane checked that, and the required node affinity keeps the pods there.
 */
const isSite = (value: string): value is Site => SITE_ID.test(value);

const validate = (project: Project, database: Database, roles: readonly DatabaseRoleRow[]): DatabaseManifestError[] => {
    const checks: [boolean, DatabaseManifestError][] = [
        [UUID.test(project.id), { kind: 'invalid-id', field: 'project.id', value: project.id }],
        [UUID.test(database.id), { kind: 'invalid-id', field: 'database.id', value: database.id }],
        [DNS_LABEL.test(project.name), { kind: 'invalid-name', field: 'project.name', value: project.name }],
        [DNS_LABEL.test(database.name), { kind: 'invalid-name', field: 'database.name', value: database.name }],
        [
            database.projectId === project.id,
            { kind: 'project-mismatch', projectId: project.id, databaseProjectId: database.projectId },
        ],
        [isSite(database.homeSite), { kind: 'invalid-site', value: database.homeSite }],
        [Number.isInteger(database.memoryMb), { kind: 'invalid-memory', memoryMb: database.memoryMb }],
        [
            !(database.memoryMb < DATABASE_MIN_MEMORY_MB),
            { kind: 'memory-below-floor', memoryMb: database.memoryMb, minimumMb: DATABASE_MIN_MEMORY_MB },
        ],
        [
            Number.isInteger(database.storageGb) && database.storageGb > 0,
            { kind: 'invalid-storage', storageGb: database.storageGb },
        ],
        // A role's name and Secret are made of its id and level, so both must be what the control plane writes.
        ...roles.map((role): [boolean, DatabaseManifestError] => [
            UUID.test(role.id) && Object.hasOwn(ROLE_GRANTS, role.access),
            { kind: 'invalid-role', id: role.id, access: role.access },
        ]),
    ];
    return checks.filter(([valid]) => !valid).map(([, error]) => error);
};

const labelsFor = (project: Project, database: Database): Record<string, string> => ({
    [LABELS.projectId]: project.id,
    [LABELS.projectName]: project.name,
    [LABELS.databaseId]: database.id,
    [LABELS.databaseName]: database.name,
    [LABELS.managedBy]: MANAGED_BY,
});

/**
 * Labels for what CloudNativePG creates (pods, Services, PVCs): without
 * managed-by, which CloudNativePG sets on those itself.
 */
const inheritedLabels = (meta: ObjectMeta): Record<string, string> =>
    Object.fromEntries(Object.entries(meta.labels).filter(([key]) => key !== LABELS.managedBy));

const objectStoreFor = (meta: ObjectMeta, config: DatabaseConfig): ObjectStoreManifest => ({
    apiVersion: 'barmancloud.cnpg.io/v1',
    kind: 'ObjectStore',
    metadata: meta,
    spec: {
        configuration: {
            // Barman appends the Cluster's name, so each Database gets
            // s3://<bucket>/<cluster prefix>/project-<id>/db-<id>/. Ids, not
            // names: a new Database under an old name must not find the old
            // archive; the prefix does the same across clusters, whose
            // platform Databases share their ids.
            destinationPath: `s3://${config.backup.bucket}/${config.backup.prefix}/${meta.namespace}`,
            endpointURL: BACKUP_ENDPOINT,
            s3Credentials: {
                accessKeyId: { name: config.backup.credentialsSecret, key: BACKUP_CREDENTIAL_KEYS.accessKeyId },
                secretAccessKey: {
                    name: config.backup.credentialsSecret,
                    key: BACKUP_CREDENTIAL_KEYS.secretAccessKey,
                },
            },
            wal: { compression: 'gzip' },
            data: { compression: 'gzip' },
        },
        retentionPolicy: config.backup.retention,
    },
});

const clusterFor = (
    meta: ObjectMeta,
    database: Database,
    config: DatabaseConfig,
    roles: readonly DatabaseRoleRow[],
    live: LiveCluster | undefined,
    appCredentials: boolean,
): ClusterManifest => ({
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Cluster',
    metadata: meta,
    spec: {
        instances: instancesFor(config.layout).database,
        imageName: config.postgresImage,
        ...PRIMARY_RESTART,
        ...RESIZE_IN_PLACE,
        // Pods, Services and PVCs carry the labels too, so usage can be
        // attributed to the Database.
        inheritedMetadata: { labels: inheritedLabels(meta) },
        affinity: {
            // One instance per Site, never both in one.
            enablePodAntiAffinity: true,
            topologyKey: ZONE_LABEL,
            podAntiAffinityType: 'required',
            nodeAffinity: {
                requiredDuringSchedulingIgnoredDuringExecution: requireComputeSite(),
                // CloudNativePG creates the primary first; this puts it in
                // the Home site and the anti-affinity puts the standby in the
                // other one.
                preferredDuringSchedulingIgnoredDuringExecution: [
                    {
                        weight: 100,
                        preference: {
                            matchExpressions: [{ key: ZONE_LABEL, operator: 'In', values: [database.homeSite] }],
                        },
                    },
                ],
            },
        },
        // CPU: a share in proportion to the memory, no limit (decision 151).
        resources: {
            requests: { memory: `${database.memoryMb}Mi`, cpu: `${databaseCpuMillicores(database.memoryMb)}m` },
            limits: { memory: `${database.memoryMb}Mi` },
        },
        postgresql: {
            // Postgres' default of 128 MB would be half the memory floor.
            parameters: { shared_buffers: `${sharedBuffersMbFor(database, live)}MB` },
        },
        storage: {
            storageClass: config.storageClass,
            size: `${database.storageGb}Gi`,
            resizeInUseVolumes: true,
        },
        bootstrap: {
            initdb: {
                postInitApplicationSQL: [...POST_INIT_SQL],
                // The `app` user's password as a SCRAM verifier, from the control plane
                // (decision 156): CloudNativePG applies it unchanged whenever an
                // instance becomes primary, where it would salt a password of its own
                // anew and so break the Pooler's next login. Read while the Cluster
                // runs, too, so it may be added to one that exists.
                ...(appCredentials ? { secret: { name: databaseAppVerifierSecret(database) } } : {}),
            },
        },
        ...(roles.length === 0 ? {} : { managed: { roles: roles.map(managedRoleFor) } }),
        plugins: [
            {
                name: BARMAN_CLOUD_PLUGIN,
                isWALArchiver: true,
                parameters: { barmanObjectName: meta.name },
            },
        ],
    },
});

/**
 * A Pooler of the Database: `rw` follows the primary; `ro` reaches only
 * replicas, so nothing answers through it while no standby is ready
 * (decision 157).
 */
const poolerFor = (meta: ObjectMeta, cluster: string, config: DatabaseConfig, type: 'rw' | 'ro' = 'rw'): PoolerManifest => ({
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Pooler',
    metadata: meta,
    spec: {
        cluster: { name: cluster },
        instances: instancesFor(config.layout).pooler,
        type,
        pgbouncer: {
            poolMode: 'transaction',
            parameters: {
                // Lets clients use protocol-level prepared statements in
                // transaction mode.
                max_prepared_statements: '200',
                ...POOLER_DEAD_SERVER_DETECTION,
                ...POOLER_LOGIN_RETRY,
            },
        },
        template: {
            metadata: { labels: inheritedLabels(meta) },
            spec: {
                // Required by the PodSpec schema; CloudNativePG fills it in.
                containers: [],
                affinity: {
                    nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: requireComputeSite() },
                    // One PgBouncer per Site, so either Site can fail.
                    podAntiAffinity: {
                        requiredDuringSchedulingIgnoredDuringExecution: [
                            {
                                labelSelector: { matchLabels: { 'cnpg.io/poolerName': meta.name } },
                                topologyKey: ZONE_LABEL,
                            },
                        ],
                    },
                },
            },
        },
    },
});

const scheduledBackupFor = (meta: ObjectMeta, config: DatabaseConfig): ScheduledBackupManifest => ({
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'ScheduledBackup',
    metadata: meta,
    spec: {
        cluster: { name: meta.name },
        schedule: config.backup.schedule,
        method: 'plugin',
        pluginConfiguration: { name: BARMAN_CLOUD_PLUGIN },
        // A Database has a base backup from the start, not only after the
        // first scheduled run.
        immediate: true,
        // Spares the primary the backup's I/O.
        target: 'prefer-standby',
        backupOwnerReference: 'self',
    },
});

/** Where a restored Database's data comes from. */
export interface RestoreSource {
    /**
     * The Database whose backups are restored. Its ObjectStore must still
     * exist, in the same Project: the restore reads it from its own namespace.
     */
    readonly database: Pick<Database, 'id' | 'projectId'>;
    /**
     * RFC 3339 with a time zone, e.g. `2026-10-17T10:30:00Z`; undefined: the
     * latest point the source's archive reaches.
     */
    readonly targetTime?: string | undefined;
}

export type RestoreError =
    | DatabaseManifestError
    | { readonly kind: 'invalid-id'; readonly field: 'source.databaseId'; readonly value: string }
    | { readonly kind: 'restore-into-source'; readonly databaseId: string }
    | { readonly kind: 'source-in-other-project'; readonly projectId: string; readonly sourceProjectId: string }
    | { readonly kind: 'invalid-target-time'; readonly value: string };

/** Date-time with an explicit offset; Postgres would read a bare time as server-local. */
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/;

/** RFC3339 shape and a real calendar time: Date.parse turns 02-30 into 03-02. */
const isRfc3339 = (value: string): boolean => {
    const match = RFC3339.exec(value);
    if (match === null) {
        return false;
    }
    const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
        number,
        number,
        number,
        number,
        number,
        number,
    ];
    const [offsetHour, offsetMinute] = [Number(match[9] ?? 0), Number(match[10] ?? 0)];
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return (
        month >= 1 &&
        month <= 12 &&
        day >= 1 &&
        day <= daysInMonth &&
        hour <= 23 &&
        minute <= 59 &&
        second <= 59 &&
        offsetHour <= 23 &&
        offsetMinute <= 59
    );
};

const RESTORE_SOURCE = 'origin';

/**
 * The objects of a new Database that starts as a copy of `source` at its
 * target time (or the latest point its archive reaches), read from the source's ObjectStore (WAL replay across
 * timelines, so also past a failover). The new Database archives into its
 * own folder; the source's archive is only read. Restoring in place is not
 * possible: CloudNativePG only bootstraps a Cluster when it is created.
 */
export function restoredDatabaseManifests(
    project: Project,
    database: Database,
    config: DatabaseConfig,
    source: RestoreSource,
    roles: readonly DatabaseRoleRow[] = [],
    live?: LiveCluster,
    appCredentials = false,
): Result<DatabaseManifests, RestoreError[]> {
    const checks: [boolean, RestoreError][] = [
        [UUID.test(source.database.id), { kind: 'invalid-id', field: 'source.databaseId', value: source.database.id }],
        [source.database.id !== database.id, { kind: 'restore-into-source', databaseId: database.id }],
        [
            source.database.projectId === project.id,
            { kind: 'source-in-other-project', projectId: project.id, sourceProjectId: source.database.projectId },
        ],
        [
            source.targetTime === undefined || isRfc3339(source.targetTime),
            { kind: 'invalid-target-time', value: source.targetTime ?? '' },
        ],
    ];
    const sourceErrors = checks.filter(([valid]) => !valid).map(([, error]) => error);
    const result = databaseManifests(project, database, config, roles, live, appCredentials);
    const errors = [...(result.ok ? [] : result.error), ...sourceErrors];
    if (!result.ok || errors.length > 0) {
        return err(errors);
    }
    const { cluster } = result.value;
    const archive = clusterName(source.database);
    return ok({
        ...result.value,
        cluster: {
            ...cluster,
            spec: {
                ...cluster.spec,
                bootstrap: {
                    recovery: {
                        source: RESTORE_SOURCE,
                        // Without a target, recovery replays every WAL file in the archive.
                        ...(source.targetTime === undefined ? {} : { recoveryTarget: { targetTime: source.targetTime } }),
                    },
                },
                externalClusters: [
                    {
                        name: RESTORE_SOURCE,
                        plugin: {
                            name: BARMAN_CLOUD_PLUGIN,
                            parameters: { barmanObjectName: archive, serverName: archive },
                        },
                    },
                ],
            },
        },
    });
}

/**
 * The Kubernetes objects that run `database` with the callers' `roles`, or
 * every reason it cannot run. `live` is its Cluster as it is now, absent
 * for a new one; with `appCredentials` the Cluster reads the `app` user's
 * password from the control plane's Secret (decision 156).
 */
export function databaseManifests(
    project: Project,
    database: Database,
    config: DatabaseConfig,
    roles: readonly DatabaseRoleRow[] = [],
    live?: LiveCluster,
    appCredentials = false,
): Result<DatabaseManifests, DatabaseManifestError[]> {
    const errors = validate(project, database, roles);
    if (errors.length > 0) {
        return err(errors);
    }
    const namespace = projectNamespace(project.id);
    const labels = labelsFor(project, database);
    const meta = (name: string): ObjectMeta => ({ name, namespace, labels: { ...labels } });
    const cluster = clusterName(database);
    return ok({
        objectStore: objectStoreFor(meta(cluster), config),
        cluster: clusterFor(meta(cluster), database, config, roles, live, appCredentials),
        pooler: poolerFor(meta(poolerName(database)), cluster, config),
        ...(instancesFor(config.layout).database > 1 ? { readPooler: poolerFor(meta(readPoolerName(database)), cluster, config, 'ro') } : {}),
        scheduledBackup: scheduledBackupFor(meta(cluster), config),
    });
}
