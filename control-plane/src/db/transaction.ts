/** Running statements in one transaction on one pooled connection. */
import type pg from 'pg';

/**
 * Runs `work` in a transaction: commits when `commit` says so for its
 * result, rolls back otherwise or when it throws (and rethrows), and always
 * returns the connection to the pool.
 */
export async function inTransaction<T>(
    pool: pg.Pool,
    work: (client: pg.PoolClient) => Promise<T>,
    commit: (result: T) => boolean,
): Promise<T> {
    const client = await pool.connect();
    return (async () => {
        await client.query('begin');
        const result = await work(client);
        await client.query(commit(result) ? 'commit' : 'rollback');
        return result;
    })()
        .catch(async (error: unknown) => {
            await client.query('rollback').catch(() => undefined);
            throw error;
        })
        .finally(() => client.release());
}
