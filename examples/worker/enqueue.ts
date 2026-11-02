/**
 * The `enqueue` One-off job of the worker demo: adds a batch of tasks, as
 * many as its argument says (default 10), and waits until the workers
 * have done them all. It exits 0 then, so `oup job run enqueue -- 100`
 * succeeding shows that the worker Service took every task; without
 * workers, the Job's timeout fails the run.
 */
import { log } from '../shared/http.js';
import { poolFromEnv, postgresQueue } from './store.js';
import { parseWhole, waitForBatch } from './tasks.js';

const count = parseWhole(process.argv[2], 'the number of tasks', 10, 1, 10_000);
if (!count.ok) {
    log({ msg: count.error });
    process.exit(2);
}
const pool = poolFromEnv();
if (pool === undefined) {
    log({ msg: 'DATABASE_URL is not set: give the Project a Database' });
    process.exit(1);
}

const queue = await postgresQueue(pool, 'enqueue');
const batch = await queue.enqueue(count.value);
log({ msg: 'tasks enqueued', batch, count: count.value });
const progress = await waitForBatch(queue, batch, count.value, { intervalMs: 1000, log });
log({ msg: 'all tasks done', batch, count: count.value, byWorker: progress.byWorker });
await pool.end();
