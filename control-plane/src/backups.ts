/**
 * The backup bucket on Hetzner Object Storage, as far as the control plane
 * touches it: removing a deleted Database's folder once its retention window
 * has passed (ARCHITECTURE.md, decision 60).
 */
import { S3Client } from '@aws-sdk/client-s3';
import { type Result, err } from './result.js';
import { deleteAllObjects } from './s3.js';

/** Hetzner Object Storage in Nuremberg, where no Database instance runs (decision 27). */
export const BACKUP_ENDPOINT = 'https://nbg1.your-objectstorage.com';

export interface BackupStore {
    /** Deletes every object under `prefix`; returns how many. */
    deletePrefix(prefix: string): Promise<Result<number, string>>;
}

export interface S3Config {
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
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
            // A prefix without the trailing slash would also match db-<id>-something.
            if (!prefix.endsWith('/') || prefix === '/') {
                return err(`refusing to delete prefix ${JSON.stringify(prefix)}`);
            }
            return deleteAllObjects(client, config.bucket, prefix);
        },
    };
}
