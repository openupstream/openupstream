import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import { type TestDatabase, closingPool, createTestDatabase } from './postgres.js';

let db: TestDatabase;

before(async () => {
    db = await createTestDatabase();
});

after(async () => {
    await db.close();
});

test('a closing pool ends only once every connection it opened has closed', async () => {
    const { pool, end } = closingPool(db.url);
    const opened: pg.PoolClient[] = [];
    const ended: pg.PoolClient[] = [];
    pool.on('connect', (client) => {
        opened.push(client);
        client.once('end', () => ended.push(client));
    });
    // Concurrent queries make the pool open several connections.
    await Promise.all(Array.from({ length: 4 }, () => pool.query('select pg_sleep(0.05)')));
    assert.ok(opened.length > 1);
    await end();
    assert.equal(ended.length, opened.length);
});
