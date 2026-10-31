import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { type TestDatabase, createTestDatabase } from '../testing/postgres.js';
import { inTransaction } from './transaction.js';

let db: TestDatabase;

before(async () => {
    db = await createTestDatabase();
    await db.pool.query('create table notes (text text not null)');
});

after(async () => {
    await db.close();
});

const count = async () => Number((await db.pool.query<{ n: string }>('select count(*) as n from notes')).rows[0]?.n);

test('commits when told to, rolls back otherwise', async () => {
    await inTransaction(db.pool, (client) => client.query(`insert into notes values ('kept')`).then(() => 'ok'), () => true);
    await inTransaction(db.pool, (client) => client.query(`insert into notes values ('dropped')`).then(() => 'no'), () => false);
    assert.equal(await count(), 1);
});

test('a throwing step rolls back, rethrows and returns the connection to the pool', async () => {
    const before = await count();
    for (let i = 0; i < 20; i++) {
        await assert.rejects(
            inTransaction(
                db.pool,
                async (client) => {
                    await client.query(`insert into notes values ('half')`);
                    await client.query('select * from no_such_table');
                },
                () => true,
            ),
            /no_such_table/,
        );
    }
    assert.equal(await count(), before);
    assert.equal(db.pool.waitingCount, 0);
    assert.equal(db.pool.totalCount, db.pool.idleCount, 'every connection is back in the pool');
});
