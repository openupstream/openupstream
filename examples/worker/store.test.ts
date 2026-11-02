/**
 * The queue against a real Postgres: `SKIP LOCKED` is the point of the
 * demo, and no fake shows it. Uses the server at TEST_DATABASE_URL (CI),
 * else starts one in Docker, and works in a database of its own.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { postgresQueue } from './store.js';
import { type Task, type TaskQueue, digest } from './tasks.js';

let container: StartedPostgreSqlContainer | undefined;
let serverUrl = '';
let pool: pg.Pool;
const name = `examples_worker_test_${randomBytes(6).toString('hex')}`;
const closed: Promise<void>[] = [];

async function onServer(sql: string): Promise<void> {
    const client = new pg.Client({ connectionString: serverUrl });
    await client.connect();
    await client.query(sql);
    await client.end();
}

before(async () => {
    const configured = process.env['TEST_DATABASE_URL'];
    container = configured ? undefined : await new PostgreSqlContainer('postgres:17-alpine').start();
    serverUrl = configured ?? (container as StartedPostgreSqlContainer).getConnectionUri();
    await onServer(`create database ${name}`);
    const url = new URL(serverUrl);
    url.pathname = `/${name}`;
    pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    // Wait for every connection to close before the drop, which would otherwise end them with an error.
    pool.on('connect', (client) => closed.push(new Promise((resolve) => client.once('end', () => resolve()))));
});

after(async () => {
    await pool.end();
    await Promise.all(closed);
    await onServer(`drop database ${name} with (force)`);
    await container?.stop();
});

const reset = () => pool.query('truncate tasks');
const noWork = async (task: Task): Promise<string> => task.payload;

/** A promise and the function that resolves it. */
const latch = (): { readonly promise: Promise<void>; readonly open: () => void } => {
    let open = () => {};
    const promise = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { promise, open };
};

test('the worker and its jobs create the table together without failing', async () => {
    await Promise.all([postgresQueue(pool, 'a'), postgresQueue(pool, 'b'), postgresQueue(pool, 'c')]);
});

test('a task another worker holds is skipped, not waited for', async () => {
    const a = await postgresQueue(pool, 'a');
    const b = await postgresQueue(pool, 'b');
    await reset();
    const batch = await a.enqueue(2);
    const holding = latch();
    const taken = latch();
    const first = a.takeOne(async (task) => {
        taken.open();
        await holding.promise;
        return digest(task.payload);
    });
    await taken.promise;
    const seen: Task[] = [];
    assert.equal(await b.takeOne(async (task) => (seen.push(task), digest(task.payload))), true);
    assert.equal(seen[0]?.payload, 'task 2 of 2');
    assert.equal(await b.takeOne(noWork), false);
    holding.open();
    assert.equal(await first, true);
    assert.deepEqual(await a.progress(batch), { done: 2, byWorker: { a: 1, b: 1 } });
    const { rows } = await pool.query<{ payload: string; result: string }>('select payload, result from tasks');
    assert.ok(rows.every((row) => row.result === digest(row.payload)));
});

test('workers in parallel do every task exactly once', async () => {
    const workers = await Promise.all(['a', 'b', 'c', 'd'].map((worker) => postgresQueue(pool, worker)));
    const queue = await postgresQueue(pool, 'enqueue');
    await reset();
    const batch = await queue.enqueue(40);
    const drain = async (worker: TaskQueue): Promise<number> => {
        let took = 0;
        while (await worker.takeOne(async (task) => (await new Promise((resolve) => setTimeout(resolve, 5)), digest(task.payload)))) {
            took += 1;
        }
        return took;
    };
    const took = await Promise.all(workers.map(drain));
    assert.equal(took.reduce((sum, n) => sum + n, 0), 40);
    const progress = await queue.progress(batch);
    assert.equal(progress.done, 40);
    assert.deepEqual(Object.values(progress.byWorker).reduce((sum, n) => sum + n, 0), 40);
});

test('a task whose work fails stays open for the next worker', async () => {
    const queue = await postgresQueue(pool, 'a');
    await reset();
    const batch = await queue.enqueue(1);
    await assert.rejects(queue.takeOne(() => Promise.reject(new Error('worker crashed'))), /worker crashed/);
    assert.deepEqual(await queue.progress(batch), { done: 0, byWorker: {} });
    assert.equal(await queue.takeOne(noWork), true);
    assert.deepEqual(await queue.progress(batch), { done: 1, byWorker: { a: 1 } });
});

test('cleanup deletes only tasks done longer ago than its hours', async () => {
    const queue = await postgresQueue(pool, 'a');
    await reset();
    await queue.enqueue(3);
    assert.equal(await queue.takeOne(noWork), true);
    assert.equal(await queue.takeOne(noWork), true);
    await pool.query("update tasks set done_at = now() - interval '25 hours' where id = (select min(id) from tasks)");
    assert.equal(await queue.deleteDone(24), 1);
    assert.equal(await queue.deleteDone(0), 1);
    const { rows } = await pool.query<{ open: number }>('select count(*)::int as open from tasks where done_at is null');
    assert.deepEqual(rows, [{ open: 1 }]);
});
