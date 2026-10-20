/** Deleting objects from an S3-compatible store: the backup bucket (backups.ts) and Garage (garage.ts). */
import { DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { type Result, err, ok } from './result.js';

/** DeleteObjects takes at most this many keys. */
const BATCH = 1000;

/**
 * Deletes every object in `bucket` under `prefix` (all of them without one),
 * a batch at a time; returns how many. Stops with an error if objects are
 * listed again after a delete that reported success (e.g. object lock),
 * rather than loop forever.
 */
export async function deleteAllObjects(client: S3Client, bucket: string, prefix?: string): Promise<Result<number, string>> {
    /** Deletes up to BATCH objects; returns the keys it deleted. */
    const deleteBatch = async (): Promise<string[]> => {
        const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: BATCH }));
        const keys = (listed.Contents ?? []).flatMap((object) => (object.Key === undefined ? [] : [{ Key: object.Key }]));
        if (keys.length === 0) {
            return [];
        }
        const deleted = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
        if ((deleted.Errors ?? []).length > 0) {
            throw new Error(`could not delete ${deleted.Errors?.length} objects, e.g. ${deleted.Errors?.[0]?.Key}: ${deleted.Errors?.[0]?.Message}`);
        }
        return keys.map(({ Key }) => Key);
    };
    let total = 0;
    let previous = new Set<string>();
    for (;;) {
        const batch = await deleteBatch().then(
            (keys) => ok(keys),
            (error: unknown) => err(error instanceof Error ? error.message : String(error)),
        );
        if (!batch.ok) {
            return batch;
        }
        if (batch.value.length === 0) {
            return ok(total);
        }
        if (batch.value.some((key) => previous.has(key))) {
            return err(`objects in ${bucket} remain after being deleted, e.g. ${batch.value[0]}`);
        }
        previous = new Set(batch.value);
        total += batch.value.length;
    }
}
