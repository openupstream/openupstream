/** The Postgres pool the demo apps share, for the DATABASE_URL every Service and Job of a Project with a Database gets (decision 97). */
import pg from 'pg';
import { log } from './http.js';

/**
 * The pool for DATABASE_URL, or undefined when it is not set. Short
 * timeouts: during a failover a query fails fast and the next one reaches
 * the new primary.
 */
export function poolFromEnv(max: number, env: NodeJS.ProcessEnv = process.env): pg.Pool | undefined {
    const url = env['DATABASE_URL'];
    if (url === undefined || url === '') {
        return undefined;
    }
    const pool = new pg.Pool({ connectionString: url, max, connectionTimeoutMillis: 5000, query_timeout: 10_000 });
    // An idle connection the Pooler drops must not end the process.
    pool.on('error', (error) => log({ msg: 'idle database connection lost', error: error.message }));
    return pool;
}
