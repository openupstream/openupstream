/**
 * Carries out deletes (ARCHITECTURE.md, decisions 48, 58 and 60). The API
 * only marks rows deleted; each pass then, in this order:
 *
 * 1. removes a deleted Database's Cluster, Pooler and ScheduledBackup (with
 *    the Cluster go its volumes); it records that only once the deletion is
 *    older than OPERATOR_GRACE, because an operator pass that fetched its
 *    rows before the delete can still re-apply them until then;
 * 2. once the retention window has passed, deletes its backups from the
 *    bucket, then its ObjectStore, then its row. Until then it can be
 *    restored into a new Database;
 * 3. deletes a deleted Bucket's key, objects and Garage bucket, then its
 *    row (decision 82): unlike a Database, nothing of it is kept;
 * 4. removes a deleted Project's namespace once it has no Database or
 *    Bucket rows left, then its row (which cascades to its Secrets and the
 *    like);
 * 5. deletes the waitlist's addresses nobody confirmed in time (decision
 *    86).
 *
 * Every step is idempotent and only recorded after it succeeded, so a failed
 * step is retried by the next pass.
 */
import { backupPrefix, clusterName, poolerName, projectNamespace } from '@openupstream/sdk';
import type pg from 'pg';
import type { BackupStore } from './backups.js';
import type { ObjectStorage } from './garage.js';
import type { ControlPlaneKube, ObjectRef } from './kube.js';
import { purgeUnconfirmed } from './waitlist/store.js';

export interface CleanupDeps {
    readonly pool: pg.Pool;
    readonly kube: ControlPlaneKube;
    readonly backups: BackupStore;
    readonly storage: ObjectStorage;
    /** How long a deleted Database's backups are kept, as a Postgres interval, e.g. `7 days`. */
    readonly retention: string;
    readonly log: (entry: Record<string, unknown>) => void;
}

interface DeletedDatabase {
    id: string;
    project_id: string;
}

const CNPG = 'postgresql.cnpg.io/v1';

/**
 * Longer than any operator pass can take (its Kubernetes calls time out
 * after 30 s): after this, no pass that still saw the row is running.
 */
export const OPERATOR_GRACE = '5 minutes';

const runningObjects = (database: { id: string; projectId: string }): ObjectRef[] => {
    const namespace = projectNamespace(database.projectId);
    return [
        { apiVersion: CNPG, kind: 'ScheduledBackup', namespace, name: clusterName(database) },
        { apiVersion: CNPG, kind: 'Pooler', namespace, name: poolerName(database) },
        { apiVersion: CNPG, kind: 'Cluster', namespace, name: clusterName(database) },
    ];
};

/** Removes every object, one after the other; the first error stops and is returned. */
const removeAll = async (kube: ControlPlaneKube, refs: readonly ObjectRef[]): Promise<string | undefined> => {
    for (const ref of refs) {
        const removed = await kube.remove(ref);
        if (!removed.ok) {
            return `${ref.kind} ${ref.name}: ${removed.error}`;
        }
    }
    return undefined;
};

async function removeRunningObjects(deps: CleanupDeps): Promise<void> {
    const { rows } = await deps.pool.query<DeletedDatabase & { settled: boolean }>(
        `select id, project_id, deleted_at < now() - $1::interval as settled from databases
         where deleted_at is not null and objects_removed_at is null order by deleted_at`,
        [OPERATOR_GRACE],
    );
    for (const row of rows) {
        const error = await removeAll(deps.kube, runningObjects({ id: row.id, projectId: row.project_id }));
        if (error !== undefined) {
            deps.log({ msg: 'cleanup: cannot remove Database objects', database: row.id, error });
            continue;
        }
        if (row.settled) {
            await deps.pool.query('update databases set objects_removed_at = now() where id = $1', [row.id]);
            deps.log({ msg: 'cleanup: Database objects removed, backups kept', database: row.id, retention: deps.retention });
        }
    }
}

async function purgeExpiredDatabases(deps: CleanupDeps): Promise<void> {
    const { rows } = await deps.pool.query<DeletedDatabase>(
        `select id, project_id from databases
         where objects_removed_at is not null and deleted_at < now() - $1::interval order by deleted_at`,
        [deps.retention],
    );
    for (const row of rows) {
        const deleted = await deps.backups.deletePrefix(backupPrefix(row.project_id, row.id));
        if (!deleted.ok) {
            deps.log({ msg: 'cleanup: cannot delete backups', database: row.id, error: deleted.error });
            continue;
        }
        const objectStore: ObjectRef = {
            apiVersion: 'barmancloud.cnpg.io/v1',
            kind: 'ObjectStore',
            namespace: projectNamespace(row.project_id),
            name: clusterName(row),
        };
        const error = await removeAll(deps.kube, [objectStore]);
        if (error !== undefined) {
            deps.log({ msg: 'cleanup: cannot remove ObjectStore', database: row.id, error });
            continue;
        }
        await deps.pool.query('delete from databases where id = $1', [row.id]);
        deps.log({ msg: 'cleanup: Database purged', database: row.id, backupObjects: deleted.value });
    }
}

async function purgeDeletedBuckets(deps: CleanupDeps): Promise<void> {
    const { rows } = await deps.pool.query<{ id: string; garage_bucket_id: string; access_key_id: string }>(
        'select id, garage_bucket_id, access_key_id from buckets where deleted_at is not null order by deleted_at',
    );
    for (const row of rows) {
        const deleted = await deps.storage.deleteBucket({ bucketId: row.garage_bucket_id, accessKeyId: row.access_key_id });
        if (!deleted.ok) {
            deps.log({ msg: 'cleanup: cannot delete Bucket from Garage', bucket: row.id, error: deleted.error });
            continue;
        }
        // A Route that slipped past the delete's check would keep the row; it serves nothing now.
        await deps.pool.query('with routes as (delete from routes where bucket_id = $1) delete from buckets where id = $1', [row.id]);
        deps.log({ msg: 'cleanup: Bucket purged', bucket: row.id, objects: deleted.value });
    }
}

async function purgeEmptyProjects(deps: CleanupDeps): Promise<void> {
    const { rows } = await deps.pool.query<{ id: string }>(
        `select id from projects p where deleted_at is not null
         and not exists (select 1 from databases d where d.project_id = p.id)
         and not exists (select 1 from buckets b where b.project_id = p.id) order by deleted_at`,
    );
    for (const row of rows) {
        const error = await removeAll(deps.kube, [{ apiVersion: 'v1', kind: 'Namespace', name: projectNamespace(row.id) }]);
        if (error !== undefined) {
            deps.log({ msg: 'cleanup: cannot remove namespace', project: row.id, error });
            continue;
        }
        await deps.pool.query('delete from projects where id = $1', [row.id]);
        deps.log({ msg: 'cleanup: Project purged', project: row.id });
    }
}

/** One pass over everything that is marked deleted. A database error rejects; the runner logs it. */
export async function cleanupPass(deps: CleanupDeps): Promise<void> {
    await removeRunningObjects(deps);
    await purgeExpiredDatabases(deps);
    await purgeDeletedBuckets(deps);
    await purgeEmptyProjects(deps);
    const unconfirmed = await purgeUnconfirmed(deps.pool);
    if (unconfirmed > 0) {
        deps.log({ msg: 'cleanup: unconfirmed waitlist addresses deleted', count: unconfirmed });
    }
}

/** `7d` (the DatabaseConfig's form) as a Postgres interval; undefined if malformed. */
export const retentionInterval = (retention: string): string | undefined => {
    const days = /^(\d+)d$/.exec(retention)?.[1];
    return days === undefined ? undefined : `${Number(days)} days`;
};
