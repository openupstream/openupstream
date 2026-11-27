/**
 * The backup bucket on Hetzner Object Storage, as far as the control plane
 * touches it: removing a deleted Database's folder once its retention window
 * has passed (ARCHITECTURE.md, decision 60).
 */
import { S3Client } from '@aws-sdk/client-s3';
import { type Result, err, ok } from './result.js';
import { deleteAllObjects } from './s3.js';

/** Hetzner Object Storage in Nuremberg, where no Database instance runs (decision 27). */
export const BACKUP_ENDPOINT = 'https://nbg1.your-objectstorage.com';

/**
 * The folder of one cluster in the backup bucket (decision 149): every
 * install generates its own, so clusters sharing a bucket, and a cluster
 * installed again, never find each other's archives.
 */
export const CLUSTER_PREFIX = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * The folders to delete for `prefix` (e.g. `project-<id>/db-<id>/`): the
 * one in the cluster's folder, and the same path without it, where a
 * Database deleted before decision 149 still keeps its archive. Database
 * ids are UUIDs, so that path is never another cluster's. The second can go
 * once no cluster installed before decision 149 holds deleted Databases.
 */
export function foldersToDelete(clusterPrefix: string, prefix: string): Result<readonly string[], string> {
    const key = clusterKey(clusterPrefix, prefix);
    return key.ok ? ok([key.value, prefix]) : key;
}

/** The object key prefix of `prefix` (e.g. `project-<id>/db-<id>/`) in the cluster's folder. */
export function clusterKey(clusterPrefix: string, prefix: string): Result<string, string> {
    // A prefix without the trailing slash would also match db-<id>-something.
    if (!prefix.endsWith('/') || prefix.startsWith('/')) {
        return err(`refusing to delete prefix ${JSON.stringify(prefix)}`);
    }
    if (!CLUSTER_PREFIX.test(clusterPrefix)) {
        return err(`invalid cluster prefix ${JSON.stringify(clusterPrefix)}`);
    }
    return ok(`${clusterPrefix}/${prefix}`);
}

export interface BackupStore {
    /** Deletes every object under `prefix` in this cluster's folder; returns how many. */
    deletePrefix(prefix: string): Promise<Result<number, string>>;
}

export interface S3Config {
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    /** This cluster's folder in the bucket (BACKUP_PREFIX). */
    readonly prefix: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
}

export function s3BackupStore(config: S3Config): BackupStore {
    const client = new S3Client({
        endpoint: config.endpoint,
        region: config.region,
        forcePathStyle: true,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        // S3-compatible stores do not all accept the SDK's default CRC32
        // checksums; send them only where S3 itself requires one.
        requestChecksumCalculation: 'WHEN_REQUIRED',
    });
    return {
        deletePrefix: async (prefix) => {
            const folders = foldersToDelete(config.prefix, prefix);
            if (!folders.ok) {
                return folders;
            }
            let deleted = 0;
            for (const folder of folders.value) {
                const result = await deleteAllObjects(client, config.bucket, folder);
                if (!result.ok) {
                    return result;
                }
                deleted += result.value;
            }
            return ok(deleted);
        },
    };
}
