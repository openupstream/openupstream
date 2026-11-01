import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { BackupStore } from './backups.js';
import { type CleanupDeps, cleanupPass, retentionInterval } from './cleanup.js';
import type { ControlPlaneKube, ObjectRef } from './kube.js';
import { err, ok } from './result.js';
import { type TestDatabase, createTestDatabase } from './testing/postgres.js';
import { type FakeStorage, fakeStorage } from './testing/storage.js';

let db: TestDatabase;
let accountId: string;

/** Records removes and prefix deletes; fails the kinds and prefixes listed. */
const fakes = () => {
    const removed: string[] = [];
    const prefixes: string[] = [];
    const failKinds = new Set<string>();
    let failBackups = false;
    const kube: ControlPlaneKube = {
        readCluster: async () => ok(undefined),
        readDeployment: async () => ok(undefined),
        readCronJob: async () => ok(undefined),
        remove: async (ref: ObjectRef) => {
            if (failKinds.has(ref.kind)) {
                return err('forbidden');
            }
            removed.push(`${ref.kind} ${ref.namespace === undefined ? '' : `${ref.namespace}/`}${ref.name}`);
            return ok(undefined);
        },
        applySecret: async () => ok('applied'),
    };
    const backups: BackupStore = {
        deletePrefix: async (prefix) => {
            if (failBackups) {
                return err('503 Slow Down');
            }
            prefixes.push(prefix);
            return ok(3);
        },
    };
    const storage = fakeStorage();
    return {
        removed,
        prefixes,
        storage,
        failKinds,
        failBackupsWith: (fail: boolean) => {
            failBackups = fail;
        },
        deps: (logs: Record<string, unknown>[] = []): CleanupDeps => ({
            pool: db.pool,
            kube,
            backups,
            storage,
            retention: '7 days',
            log: (entry) => logs.push(entry),
        }),
    };
};

before(async () => {
    db = await createTestDatabase();
    const { rows } = await db.pool.query<{ id: string }>(`insert into accounts (name) values ('Acme') returning id`);
    accountId = rows[0]?.id ?? '';
});

after(async () => {
    await db.close();
});

let projectId: string;
let databaseId: string;

beforeEach(async () => {
    const project = await db.pool.query<{ id: string }>(
        `insert into projects (account_id, name) values ($1, 'p-' || substr(md5(random()::text), 1, 8)) returning id`,
        [accountId],
    );
    projectId = project.rows[0]?.id ?? '';
    const database = await db.pool.query<{ id: string }>(
        `insert into databases (project_id, name, memory_mb, storage_gb) values ($1, 'orders', 256, 1) returning id`,
        [projectId],
    );
    databaseId = database.rows[0]?.id ?? '';
});

const row = async (id: string) =>
    (await db.pool.query<{ objects_removed_at: Date | null }>('select objects_removed_at from databases where id = $1', [id])).rows[0];
const ageDeletion = (id: string, interval: string) =>
    db.pool.query(`update databases set deleted_at = now() - $2::interval where id = $1`, [id, interval]);

test('a live Database is left alone', async () => {
    const { removed, prefixes, deps } = fakes();
    await cleanupPass(deps());
    assert.ok(!removed.some((entry) => entry.includes(databaseId)));
    assert.deepEqual(prefixes, []);
});

test('a deleted Database loses its running objects at once, keeps its backups until the retention passes', async () => {
    const { removed, prefixes, deps } = fakes();
    await db.pool.query('update databases set deleted_at = now() where id = $1', [databaseId]);
    await cleanupPass(deps());
    const namespace = `project-${projectId}`;
    const running = [
        `ScheduledBackup ${namespace}/db-${databaseId}`,
        `Pooler ${namespace}/db-${databaseId}-pooler`,
        `Cluster ${namespace}/db-${databaseId}`,
    ];
    assert.deepEqual(removed, running);
    assert.deepEqual(prefixes, []);

    // Within the grace period an operator pass that still saw the row may
    // re-apply the objects, so they are removed again on every pass.
    assert.equal((await row(databaseId))?.objects_removed_at, null);
    await cleanupPass(deps());
    assert.deepEqual(removed, [...running, ...running]);

    // After it, that is recorded once and not repeated.
    await ageDeletion(databaseId, '6 minutes');
    await cleanupPass(deps());
    assert.notEqual((await row(databaseId))?.objects_removed_at, null);
    removed.length = 0;

    // Within the retention window nothing more happens.
    await ageDeletion(databaseId, '6 days');
    await cleanupPass(deps());
    assert.equal(removed.length, 0);
    assert.ok(await row(databaseId));

    // After it, the backups, the ObjectStore and the row go.
    await ageDeletion(databaseId, '8 days');
    await cleanupPass(deps());
    assert.deepEqual(prefixes, [`${namespace}/db-${databaseId}/`]);
    assert.deepEqual(removed, [`ObjectStore ${namespace}/db-${databaseId}`]);
    assert.equal(await row(databaseId), undefined);
});

test('a failed step is not recorded and is retried by the next pass', async () => {
    const { removed, prefixes, failKinds, failBackupsWith, deps } = fakes();
    const logs: Record<string, unknown>[] = [];
    await ageDeletion(databaseId, '6 minutes');
    failKinds.add('Cluster');
    await cleanupPass(deps(logs));
    assert.equal((await row(databaseId))?.objects_removed_at, null);
    assert.ok(logs.some((entry) => entry['msg'] === 'cleanup: cannot remove Database objects'));

    failKinds.clear();
    await cleanupPass(deps(logs));
    assert.notEqual((await row(databaseId))?.objects_removed_at, null);

    await ageDeletion(databaseId, '8 days');
    failBackupsWith(true);
    await cleanupPass(deps(logs));
    assert.ok(await row(databaseId), 'the row stays while the backups are still there');
    assert.ok(!removed.some((entry) => entry.startsWith('ObjectStore')));

    failBackupsWith(false);
    await cleanupPass(deps(logs));
    assert.equal(await row(databaseId), undefined);
    assert.equal(prefixes.length, 1);
});

test("a deleted Project's namespace goes only after its last Database row", async () => {
    const { removed, deps } = fakes();
    await db.pool.query(
        `with p as (update projects set deleted_at = now() where id = $1 returning id, deleted_at)
         update databases d set deleted_at = p.deleted_at from p where d.project_id = p.id`,
        [projectId],
    );
    await cleanupPass(deps());
    assert.ok(!removed.includes(`Namespace project-${projectId}`), 'its Database is still within the retention window');
    assert.equal((await db.pool.query('select 1 from projects where id = $1', [projectId])).rowCount, 1);

    await ageDeletion(databaseId, '8 days');
    await cleanupPass(deps());
    assert.ok(removed.includes(`Namespace project-${projectId}`));
    assert.equal((await db.pool.query('select 1 from projects where id = $1', [projectId])).rowCount, 0);
});

/** A Bucket of the current Project, created in the fake Garage first, as the API does. */
const createBucket = async (storage: FakeStorage, name: string) => {
    const created = await storage.createBucket(name);
    assert.ok(created.ok);
    const { rows } = await db.pool.query<{ id: string }>(
        'insert into buckets (project_id, name, garage_bucket_id, access_key_id) values ($1, $2, $3, $4) returning id',
        [projectId, name, created.value.bucketId, created.value.accessKeyId],
    );
    return rows[0]?.id ?? '';
};
const bucketRow = async (id: string) => (await db.pool.query('select 1 from buckets where id = $1', [id])).rowCount === 1;

test('a deleted Bucket is deleted from Garage at once, then its row; a failure is retried', async () => {
    const { storage, deps } = fakes();
    const logs: Record<string, unknown>[] = [];
    const live = await createBucket(storage, `live-${projectId.slice(0, 8)}`);
    const doomed = await createBucket(storage, `doomed-${projectId.slice(0, 8)}`);
    await db.pool.query('update buckets set deleted_at = now() where id = $1', [doomed]);

    storage.down = true;
    await cleanupPass(deps(logs));
    assert.ok(await bucketRow(doomed), 'the row stays while Garage still has the bucket');
    assert.ok(logs.some((entry) => entry['msg'] === 'cleanup: cannot delete Bucket from Garage'));

    storage.down = false;
    await cleanupPass(deps(logs));
    assert.equal(await bucketRow(doomed), false);
    assert.ok(await bucketRow(live));
    assert.deepEqual([...storage.buckets.keys()], [`live-${projectId.slice(0, 8)}`]);
});

test("a deleted Project's namespace waits for its Buckets too", async () => {
    const { storage, removed, deps } = fakes();
    const bucket = await createBucket(storage, `p-${projectId.slice(0, 8)}`);
    await db.pool.query(
        `with p as (update projects set deleted_at = now() where id = $1 returning id, deleted_at),
         d as (update databases d set deleted_at = p.deleted_at - interval '8 days' from p where d.project_id = p.id)
         update buckets b set deleted_at = p.deleted_at from p where b.project_id = p.id`,
        [projectId],
    );
    storage.down = true;
    await cleanupPass(deps());
    await cleanupPass(deps());
    assert.ok(!removed.includes(`Namespace project-${projectId}`), 'its Bucket is still in Garage');

    storage.down = false;
    await cleanupPass(deps());
    assert.equal(await bucketRow(bucket), false);
    assert.ok(removed.includes(`Namespace project-${projectId}`));
});

test('retention in days, as the DatabaseConfig writes it', () => {
    assert.equal(retentionInterval('30d'), '30 days');
    assert.equal(retentionInterval('7d'), '7 days');
    assert.equal(retentionInterval('7 days'), undefined);
    assert.equal(retentionInterval('1w'), undefined);
});
