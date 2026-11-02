import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { globalSetup, globalTeardown } from './global-setup.js';

test('global setup keeps a configured server and teardown leaves it running', async (t) => {
    const configured = process.env['TEST_DATABASE_URL'];
    if (!configured) {
        t.skip('needs TEST_DATABASE_URL, which npm test sets');
        return;
    }
    await globalSetup();
    assert.equal(process.env['TEST_DATABASE_URL'], configured);
    await globalTeardown();

    const client = new pg.Client({ connectionString: configured });
    await client.connect();
    const { rows } = await client.query<{ one: number }>('select 1 as one');
    await client.end();
    assert.equal(rows[0]?.one, 1);
});
