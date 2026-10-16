/**
 * Database → Kubernetes objects (ARCHITECTURE.md, "Postgres" and "Backups").
 *
 * One Database becomes four objects in its Project's namespace:
 *
 * - a CloudNativePG `Cluster` with two instances: the primary in the Home
 *   site, the standby in the other compute Site;
 * - a PgBouncer `Pooler` of type `rw`, so it follows the primary;
 * - a Barman Cloud `ObjectStore` on Hetzner Object Storage NBG1, the WAL
 *   archive and base backup target;
 * - a `ScheduledBackup` taking base backups into it.
 *
 * Pure: no I/O. Invalid input is returned as errors, never thrown.
 */
import { COMPUTE_SITES, DATABASE_MIN_MEMORY_MB, type Database, type Project, type Site } from '@openupstream/sdk';
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
         * Secret in the Project's namespace with that project's S3
         * credentials under BACKUP_CREDENTIAL_KEYS.
         */
        readonly credentialsSecret: string;
        /** Point-in-time recovery window, e.g. `30d`. */
        readonly retention: string;
        /** CloudNativePG cron with a leading seconds field, e.g. `0 0 3 * * *`. */
        readonly schedule: string;
    };
}

export type ClusterManifest = Manifest<Cluster, 'postgresql.cnpg.io/v1', 'Cluster'>;
export type PoolerManifest = Manifest<Pooler, 'postgresql.cnpg.io/v1', 'Pooler'>;
export type ObjectStoreManifest = Manifest<ObjectStore, 'barmancloud.cnpg.io/v1', 'ObjectStore'>;
export type ScheduledBackupManifest = Manifest<ScheduledBackup, 'postgresql.cnpg.io/v1', 'ScheduledBackup'>;

export interface DatabaseManifests {
    readonly objectStore: ObjectStoreManifest;
    readonly cluster: ClusterManifest;
    readonly pooler: PoolerManifest;
    readonly scheduledBackup: ScheduledBackupManifest;
}

export type DatabaseManifestError =
    | { readonly kind: 'invalid-id'; readonly field: 'project.id' | 'database.id'; readonly value: string }
    | { readonly kind: 'invalid-name'; readonly field: 'project.name' | 'database.name'; readonly value: string }
    | { readonly kind: 'project-mismatch'; readonly projectId: string; readonly databaseProjectId: string }
    | { readonly kind: 'not-a-compute-site'; readonly value: string }
    | { readonly kind: 'memory-below-floor'; readonly memoryMb: number; readonly minimumMb: number }
    | { readonly kind: 'invalid-storage'; readonly storageGb: number };

/** The Cluster's name; also names its ObjectStore, ScheduledBackup and backup folder. */
export const clusterName = (database: Pick<Database, 'id'>): string => `db-${database.id}`;

/** Cannot share the Cluster's name, nor `<cluster>-rw`, which the Cluster's own Service takes. */
export const poolerName = (database: Pick<Database, 'id'>): string => `${clusterName(database)}-pooler`;

/** Rows come from the database as strings; the type alone does not guarantee this. */
const isComputeSite = (value: string): value is Site => (COMPUTE_SITES as readonly string[]).includes(value);

const validate = (project: Project, database: Database): DatabaseManifestError[] => {
    const checks: [boolean, DatabaseManifestError][] = [
        [UUID.test(project.id), { kind: 'invalid-id', field: 'project.id', value: project.id }],
        [UUID.test(database.id), { kind: 'invalid-id', field: 'database.id', value: database.id }],
        [DNS_LABEL.test(project.name), { kind: 'invalid-name', field: 'project.name', value: project.name }],
        [DNS_LABEL.test(database.name), { kind: 'invalid-name', field: 'database.name', value: database.name }],
        [
            database.projectId === project.id,
            { kind: 'project-mismatch', projectId: project.id, databaseProjectId: database.projectId },
        ],
        [isComputeSite(database.homeSite), { kind: 'not-a-compute-site', value: database.homeSite }],
        [
            Number.isInteger(database.memoryMb) && database.memoryMb >= DATABASE_MIN_MEMORY_MB,
            { kind: 'memory-below-floor', memoryMb: database.memoryMb, minimumMb: DATABASE_MIN_MEMORY_MB },
        ],
        [
            Number.isInteger(database.storageGb) && database.storageGb > 0,
            { kind: 'invalid-storage', storageGb: database.storageGb },
        ],
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

const objectStoreFor = (meta: ObjectMeta, config: DatabaseConfig): ObjectStoreManifest => ({
    apiVersion: 'barmancloud.cnpg.io/v1',
    kind: 'ObjectStore',
    metadata: meta,
    spec: {
        configuration: {
            // Barman appends the Cluster's name, so each Database gets
            // s3://<bucket>/project-<id>/db-<id>/. Ids, not names: a new
            // Database under an old name must not find the old archive.
            destinationPath: `s3://${config.backup.bucket}/${meta.namespace}`,
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

const clusterFor = (meta: ObjectMeta, database: Database, config: DatabaseConfig): ClusterManifest => ({
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Cluster',
    metadata: meta,
    spec: {
        instances: DATABASE_INSTANCES,
        imageName: config.postgresImage,
        // Pods, Services and PVCs carry the labels too, so usage can be
        // attributed to the Database.
        inheritedMetadata: { labels: meta.labels },
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
        resources: {
            requests: { memory: `${database.memoryMb}Mi` },
            limits: { memory: `${database.memoryMb}Mi` },
        },
        postgresql: {
            // Postgres' default of 128 MB would be half the memory floor.
            parameters: { shared_buffers: `${Math.floor(database.memoryMb / 4)}MB` },
        },
        storage: {
            storageClass: config.storageClass,
            size: `${database.storageGb}Gi`,
            resizeInUseVolumes: true,
        },
        bootstrap: {
            initdb: { postInitApplicationSQL: ['CREATE EXTENSION IF NOT EXISTS vector'] },
        },
        plugins: [
            {
                name: BARMAN_CLOUD_PLUGIN,
                isWALArchiver: true,
                parameters: { barmanObjectName: meta.name },
            },
        ],
    },
});

const poolerFor = (meta: ObjectMeta, cluster: string): PoolerManifest => ({
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Pooler',
    metadata: meta,
    spec: {
        cluster: { name: cluster },
        instances: POOLER_INSTANCES,
        type: 'rw',
        pgbouncer: {
            poolMode: 'transaction',
            // Lets clients use protocol-level prepared statements in
            // transaction mode.
            parameters: { max_prepared_statements: '200' },
        },
        template: {
            metadata: { labels: meta.labels },
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

/** The Kubernetes objects that run `database`, or every reason it cannot run. */
export function databaseManifests(
    project: Project,
    database: Database,
    config: DatabaseConfig,
): Result<DatabaseManifests, DatabaseManifestError[]> {
    const errors = validate(project, database);
    if (errors.length > 0) {
        return err(errors);
    }
    const namespace = projectNamespace(project.id);
    const labels = labelsFor(project, database);
    const meta = (name: string): ObjectMeta => ({ name, namespace, labels: { ...labels } });
    const cluster = clusterName(database);
    return ok({
        objectStore: objectStoreFor(meta(cluster), config),
        cluster: clusterFor(meta(cluster), database, config),
        pooler: poolerFor(meta(poolerName(database)), cluster),
        scheduledBackup: scheduledBackupFor(meta(cluster), config),
    });
}
