/**
 * Buckets of one Project as the public API sees them: only live ones.
 * Callers check first that the Project is live and the caller's
 * (projects/store.ts). Creating one creates its Garage bucket and key first
 * (../garage.ts) and records them only when that worked; deleting only
 * marks the row, and the cleanup (src/cleanup.ts) removes it from Garage.
 */
import type { Bucket } from '@openupstream/sdk';
import type pg from 'pg';
import { ACCOUNT_HELD, FOREIGN_KEY_VIOLATION, UNIQUE_VIOLATION, unlessCodes } from '../db/errors.js';
import type { GarageBucket, ObjectStorage } from '../garage.js';
import { inTransaction } from '../db/transaction.js';
import { type Result, err, ok } from '../result.js';

/** A Bucket with its counterparts in Garage, which the API does not show. */
export interface BucketRecord extends Bucket, GarageBucket {}

interface BucketRow {
    id: string;
    project_id: string;
    name: string;
    garage_bucket_id: string;
    access_key_id: string;
    created_at: Date;
}

const toBucket = (row: BucketRow): BucketRecord => ({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    bucketId: row.garage_bucket_id,
    accessKeyId: row.access_key_id,
});

const COLUMNS = 'id, project_id, name, garage_bucket_id, access_key_id, created_at';

export async function listBuckets(pool: pg.Pool, projectId: string): Promise<BucketRecord[]> {
    const { rows } = await pool.query<BucketRow>(
        `select ${COLUMNS} from buckets where project_id = $1 and deleted_at is null order by created_at, id`,
        [projectId],
    );
    return rows.map(toBucket);
}

export async function getBucket(pool: pg.Pool, projectId: string, id: string): Promise<BucketRecord | undefined> {
    const { rows } = await pool.query<BucketRow>(
        `select ${COLUMNS} from buckets where id = $1 and project_id = $2 and deleted_at is null`,
        [id, projectId],
    );
    return rows.map(toBucket)[0];
}

export type CreateBucketError =
    | { readonly kind: 'name-taken'; readonly name: string }
    | { readonly kind: 'held' }
    | { readonly kind: 'project-deleted' }
    | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * Creates the bucket and its key in Garage, then the row. Garage refuses a
 * name that is taken, also by a Bucket that is still being deleted. When the
 * row cannot be inserted (a Hold, or the Project was deleted meanwhile), the
 * Garage bucket is deleted again. `name` is validated by the API; the schema
 * checks it again.
 */
export async function createBucket(
    pool: pg.Pool,
    storage: ObjectStorage,
    projectId: string,
    name: string,
): Promise<Result<BucketRecord, CreateBucketError>> {
    const created = await storage.createBucket(name);
    if (!created.ok) {
        return err(created.error.kind === 'name-taken' ? { kind: 'name-taken', name } : created.error);
    }
    const garage = created.value;
    const inserted = await unlessCodes<pg.QueryResult<BucketRow>, CreateBucketError>(
        pool.query<BucketRow>(
            `insert into buckets (project_id, name, garage_bucket_id, access_key_id)
             values ($1, $2, $3, $4) returning ${COLUMNS}`,
            [projectId, name, garage.bucketId, garage.accessKeyId],
        ),
        {
            [UNIQUE_VIOLATION]: { kind: 'name-taken', name },
            [ACCOUNT_HELD]: { kind: 'held' },
            [FOREIGN_KEY_VIOLATION]: { kind: 'project-deleted' },
        },
    );
    if (!inserted.ok) {
        // Empty and unknown to anyone; if this fails too, the name stays taken in Garage.
        await storage.deleteBucket(garage);
        return inserted;
    }
    // An insert … returning without a conflict always returns its row.
    return ok(toBucket(inserted.value.rows[0] as BucketRow));
}

/**
 * Marks the Bucket deleted, unless a Route still serves it (ARCHITECTURE.md,
 * "Routing and domains"). The Bucket's row is locked first, and Routes are
 * checked in a separate statement after that: creating a Route holds a
 * share lock on the row, so a Route committed while this waited is seen.
 */
export async function deleteBucket(pool: pg.Pool, projectId: string, id: string): Promise<'deleted' | 'not-found' | 'routed'> {
    return inTransaction(
        pool,
        async (client) => {
            const bucket = await client.query(
                'select 1 from buckets where id = $1 and project_id = $2 and deleted_at is null for update',
                [id, projectId],
            );
            if (bucket.rowCount !== 1) {
                return 'not-found' as const;
            }
            const routed = await client.query('select 1 from routes where bucket_id = $1 limit 1', [id]);
            if (routed.rowCount !== 0) {
                return 'routed' as const;
            }
            await client.query('update buckets set deleted_at = now() where id = $1', [id]);
            return 'deleted' as const;
        },
        (outcome) => outcome === 'deleted',
    );
}
