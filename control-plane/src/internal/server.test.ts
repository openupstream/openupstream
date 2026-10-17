import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { type DatabaseRow, INTERNAL_DATABASES_PATH, PLATFORM } from '@openupstream/sdk';
import { err, ok } from '../result.js';
import type { Authenticate } from './auth.js';
import { createInternalServer } from './server.js';

const operator = 'system:serviceaccount:openupstream-system:databases-operator';
const rows: DatabaseRow[] = [{ project: PLATFORM.project, database: PLATFORM.database }];

/** Tokens are the username they authenticate as; `broken` makes the review fail. */
const authenticate: Authenticate = async (token) =>
    token === 'broken'
        ? err({ kind: 'review-failed', message: 'connection refused' })
        : token.startsWith('system:')
          ? ok({ username: token })
          : err({ kind: 'unauthenticated', reason: 'invalid' });

let listFails = false;
let server: Server;
let base: string;

before(async () => {
    server = createInternalServer({
        authenticate,
        allowedCallers: new Set([operator]),
        listDatabaseRows: async () => {
            if (listFails) {
                throw new Error('database down');
            }
            return rows;
        },
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
    server.close();
});

const get = (token?: string, path = INTERNAL_DATABASES_PATH, method = 'GET') =>
    fetch(`${base}${path}`, { method, headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });

test('the databases operator gets every Database with its Project', async () => {
    const response = await get(operator);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), rows);
});

test('without a token: 401', async () => {
    assert.equal((await get()).status, 401);
});

test('a token the API server rejects: 401', async () => {
    assert.equal((await get('forged')).status, 401);
});

test('any other ServiceAccount: 403', async () => {
    assert.equal((await get('system:serviceaccount:project-x:default')).status, 403);
});

test('when the token cannot be checked: 503, so the operator retries', async () => {
    assert.equal((await get('broken')).status, 503);
});

test('unknown paths and methods', async () => {
    assert.equal((await get(operator, '/internal/v1/other')).status, 404);
    const post = await get(operator, INTERNAL_DATABASES_PATH, 'POST');
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET');
});

test('a failing database answers 500 without details', async () => {
    listFails = true;
    const response = await get(operator);
    listFails = false;
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'internal error' });
});
