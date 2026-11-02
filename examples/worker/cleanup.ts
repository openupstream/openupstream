/**
 * The `cleanup` Cron job of the worker demo: deletes the tasks done more
 * than its argument's hours ago (default 24), as a TTL on a DynamoDB table
 * would. `oup job run cleanup -- 0` deletes every done task at once.
 */
import { log } from '../shared/http.js';
import { poolFromEnv, postgresQueue } from './store.js';
import { parseWhole } from './tasks.js';

const hours = parseWhole(process.argv[2], 'the hours a done task is kept', 24, 0, 24 * 365);
if (!hours.ok) {
    log({ msg: hours.error });
    process.exit(2);
}
const pool = poolFromEnv();
if (pool === undefined) {
    log({ msg: 'DATABASE_URL is not set: give the Project a Database' });
    process.exit(1);
}

const queue = await postgresQueue(pool, 'cleanup');
const deleted = await queue.deleteDone(hours.value);
log({ msg: 'done tasks deleted', deleted, olderThanHours: hours.value });
await pool.end();
