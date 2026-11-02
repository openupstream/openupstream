/**
 * notes: a Service with a Postgres Database (ARCHITECTURE.md, decision 30).
 * It reads DATABASE_URL, which the platform gives every Service of a
 * Project with a Database (decision 97), creates its table on start and
 * serves a page and a JSON API. The step 5 acceptance test writes to it
 * every second while a whole Site is switched off.
 */
import { createServer } from 'node:http';
import { poolFromEnv } from '../shared/database.js';
import { log, portFromEnv } from '../shared/http.js';
import { notesHandler } from './notes.js';
import { postgresStore } from './store.js';

const pool = poolFromEnv(5);
if (pool === undefined) {
    log({ msg: 'DATABASE_URL is not set: give the Project a Database' });
    process.exit(1);
}
const store = await postgresStore(pool);
const server = createServer(notesHandler(store));
server.listen(portFromEnv(), () => log({ msg: 'notes listening', port: portFromEnv() }));

process.on('SIGTERM', () => {
    log({ msg: 'stopping' });
    server.close(() => void pool.end().then(() => process.exit(0)));
});
