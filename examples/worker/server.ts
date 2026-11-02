/**
 * worker: a Service without a port (ARCHITECTURE.md, decisions 30 and 98)
 * that takes tasks from a queue in its Project's Database with
 * `FOR UPDATE SKIP LOCKED` (decision 8), so any number of replicas share
 * the work and a task is done once. The image's default command; the
 * `enqueue` One-off job and the `cleanup` Cron job run the same image with
 * another command.
 *
 * WORK_MS (default 100) is how long a task takes, so the share of each
 * replica shows.
 */
import { hostname } from 'node:os';
import { log } from '../shared/http.js';
import { poolFromEnv, postgresQueue } from './store.js';
import { type Task, digest, parseWhole, runWorker, sleep } from './tasks.js';

const pool = poolFromEnv();
if (pool === undefined) {
    log({ msg: 'DATABASE_URL is not set: give the Project a Database' });
    process.exit(1);
}
const workMs = parseWhole(process.env['WORK_MS'], 'WORK_MS', 100, 0, 60_000);
if (!workMs.ok) {
    log({ msg: workMs.error });
    process.exit(1);
}

const worker = hostname();
const queue = await postgresQueue(pool, worker);
const stop = new AbortController();
// The platform sends SIGTERM on a rollout or a scale down: finish the task at hand, then end.
process.on('SIGTERM', () => {
    log({ msg: 'stopping after the task at hand' });
    stop.abort();
});

log({ msg: 'worker started', worker });
const work = async (task: Task): Promise<string> => {
    log({ msg: 'task taken', id: task.id, worker });
    await sleep(workMs.value);
    return digest(task.payload);
};
const done = await runWorker(queue, work, { signal: stop.signal, idleMs: 1000, retryMs: 2000, log });
log({ msg: 'worker stopped', done });
await pool.end();
