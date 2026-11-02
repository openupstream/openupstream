/** The task queue in Postgres, through the Project's Pooler (DATABASE_URL). */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { log } from '../shared/http.js';
import type { Progress, Task, TaskQueue } from './tasks.js';

const SCHEMA = [
    `create table if not exists tasks (
        id bigint generated always as identity primary key,
        batch uuid not null,
        payload text not null,
        result text,
        worker text,
        created_at timestamptz not null default now(),
        done_at timestamptz
    )`,
    'create index if not exists tasks_open on tasks (id) where done_at is null',
    'create index if not exists tasks_batch on tasks (batch)',
    'create index if not exists tasks_done_at on tasks (done_at) where done_at is not null',
];

/** Any number shared by the worker and its jobs: they create the table one at a time. */
const SCHEMA_LOCK = 4_242_002;

/**
 * The pool for DATABASE_URL, or undefined when it is not set. Short
 * timeouts: during a failover a query fails fast and the retry reaches the
 * new primary.
 */
export function poolFromEnv(env: NodeJS.ProcessEnv = process.env): pg.Pool | undefined {
    const url = env['DATABASE_URL'];
    if (url === undefined || url === '') {
        return undefined;
    }
    const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 5000, query_timeout: 10_000 });
    // An idle connection the Pooler drops must not end the process.
    pool.on('error', (error) => log({ msg: 'idle database connection lost', error: error.message }));
    return pool;
}

/**
 * Runs `steps` in one transaction on one connection. On a failure it rolls
 * back, drops the connection, which may be the broken part, and rejects.
 */
async function inTransaction<T>(pool: pg.Pool, steps: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    return client
        .query('begin')
        .then(() => steps(client))
        .then(async (value) => {
            await client.query('commit');
            client.release();
            return value;
        })
        .catch(async (error: unknown) => {
            await client.query('rollback').catch(() => undefined);
            client.release(true);
            throw error;
        });
}

/**
 * Creates the table once. A transaction-level lock, since PgBouncer in
 * transaction mode gives no session to hold one across statements.
 */
const migrate = (pool: pg.Pool): Promise<void> =>
    inTransaction(pool, async (client) => {
        await client.query('select pg_advisory_xact_lock($1)', [SCHEMA_LOCK]);
        for (const statement of SCHEMA) {
            await client.query(statement);
        }
    });

/** The queue; `worker` names who did a task, the pod's hostname on the platform. */
export async function postgresQueue(pool: pg.Pool, worker: string): Promise<TaskQueue> {
    await migrate(pool);
    return {
        takeOne: (work) =>
            inTransaction(pool, async (client) => {
                const { rows } = await client.query<Task>(
                    'select id, payload from tasks where done_at is null order by id limit 1 for update skip locked',
                );
                const task = rows[0];
                if (task === undefined) {
                    return false;
                }
                const result = await work(task);
                await client.query('update tasks set result = $2, worker = $3, done_at = now() where id = $1', [task.id, result, worker]);
                return true;
            }),
        enqueue: async (count) => {
            const batch = randomUUID();
            await pool.query(
                `insert into tasks (batch, payload) select $1, 'task ' || n || ' of ' || $2::int from generate_series(1, $2::int) as n`,
                [batch, count],
            );
            return batch;
        },
        progress: async (batch): Promise<Progress> => {
            const { rows } = await pool.query<{ worker: string; done: number }>(
                'select worker, count(*)::int as done from tasks where batch = $1 and done_at is not null group by worker order by worker',
                [batch],
            );
            return {
                done: rows.reduce((sum, row) => sum + row.done, 0),
                byWorker: Object.fromEntries(rows.map((row) => [row.worker, row.done])),
            };
        },
        deleteDone: async (hours) =>
            (await pool.query('delete from tasks where done_at < now() - make_interval(hours => $1)', [hours])).rowCount ?? 0,
    };
}
