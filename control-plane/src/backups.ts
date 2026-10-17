/**
 * The backup bucket on Hetzner Object Storage, as far as the control plane
 * touches it: removing a deleted Database's folder once its retention window
 * has passed (ARCHITECTURE.md, decision 60).
 */
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { type Result, err, ok } from './result.js';

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

/** DeleteObjects takes at most this many keys. */
const BATCH = 1000;

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
    /** Deletes up to BATCH objects; returns the keys it deleted. */
    const deleteBatch = async (prefix: string): Promise<string[]> => {
        const listed = await client.send(new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, MaxKeys: BATCH }));
        const keys = (listed.Contents ?? []).flatMap((object) => (object.Key === undefined ? [] : [{ Key: object.Key }]));
        if (keys.length === 0) {
            return [];
        }
        const deleted = await client.send(
            new DeleteObjectsCommand({ Bucket: config.bucket, Delete: { Objects: keys, Quiet: true } }),
        );
        if ((deleted.Errors ?? []).length > 0) {
            throw new Error(`could not delete ${deleted.Errors?.length} objects, e.g. ${deleted.Errors?.[0]?.Key}: ${deleted.Errors?.[0]?.Message}`);
        }
        return keys.map(({ Key }) => Key);
    };
    return {
        deletePrefix: async (prefix) => {
            // A prefix without the trailing slash would also match db-<id>-something.
            if (!prefix.endsWith('/') || prefix === '/') {
                return err(`refusing to delete prefix ${JSON.stringify(prefix)}`);
            }
            let total = 0;
            let previous = new Set<string>();
            for (;;) {
                const batch = await deleteBatch(prefix).then(
                    (keys) => ok(keys),
                    (error: unknown) => err(error instanceof Error ? error.message : String(error)),
                );
                if (!batch.ok) {
                    return batch;
                }
                if (batch.value.length === 0) {
                    break;
                }
                // Listed again after a delete that reported success: the store
                // keeps them (e.g. object lock). Stop rather than loop forever.
                if (batch.value.some((key) => previous.has(key))) {
                    return err(`objects under ${prefix} remain after being deleted, e.g. ${batch.value[0]}`);
                }
                previous = new Set(batch.value);
                total += batch.value.length;
            }
            return ok(total);
        },
    };
}
