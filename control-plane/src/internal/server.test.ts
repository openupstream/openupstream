import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
    type AccountRecord,
    type DatabaseRow,
    type DomainRouting,
    INTERNAL_ACCOUNTS_PATH,
    INTERNAL_DATABASES_PATH,
    INTERNAL_ROUTES_PATH,
    PLATFORM,
} from '@openupstream/sdk';
import { err, ok } from '../result.js';
import type { Authenticate } from './auth.js';
import { createInternalServer } from './server.js';

const operator = 'system:serviceaccount:openupstream-system:databases-operator';
const billing = 'system:serviceaccount:project-00000000-0000-4000-8000-000000000002:billing';
const routesOperator = 'system:serviceaccount:openupstream-system:routes-operator';
const routings: DomainRouting[] = [
    {
        projectId: PLATFORM.project.id,
        projectName: PLATFORM.project.name,
        domainId: '0b7c3f1e-2d4a-4c8b-9e6f-111111111111',
        hostname: 'shop-a1b2c3d4.openupstream.app',
        routes: [{ id: '0b7c3f1e-2d4a-4c8b-9e6f-222222222222', pathPrefix: '/', bucketName: 'shop-site', spaFallback: true }],
    },
];
const rows: DatabaseRow[] = [{ project: PLATFORM.project, database: PLATFORM.database }];
const accountId = '0b7c3f1e-2d4a-4c8b-9e6f-1a2b3c4d5e6f';
const unknownId = '0b7c3f1e-2d4a-4c8b-9e6f-000000000000';

/** Tokens are the username they authenticate as; `broken` makes the review fail. */
const authenticate: Authenticate = async (token) =>
    token === 'broken'
        ? err({ kind: 'review-failed', message: 'connection refused' })
        : token.startsWith('system:')
          ? ok({ username: token })
          : err({ kind: 'unauthenticated', reason: 'invalid' });

let listFails = false;
/** The one Account's Holds, as the fake store keeps them. */
const holds = new Set<string>();
let server: Server;
let base: string;

const record = (): AccountRecord => ({
    id: accountId,
    name: 'Erin AG',
    createdAt: '2026-10-20T00:00:00.000Z',
    holds: [...holds].sort(),
    members: [{ authSubject: 'erin', email: 'erin@example.test' }],
});

before(async () => {
    server = createInternalServer({
        authenticate,
        allowedCallers: new Set([operator]),
        billingCallers: new Set([billing]),
        routesCallers: new Set([routesOperator]),
        listDomainRoutings: async () => routings,
        listDatabaseRows: async () => {
            if (listFails) {
                throw new Error('database down');
            }
            return rows;
        },
        getAccount: async (id) => (id === accountId ? record() : undefined),
        placeHold: async (id, reason) => id === accountId && (holds.add(reason), true),
        liftHold: async (id, reason) => id === accountId && (holds.delete(reason), true),
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

test('the billing service reads an Account with its Holds and Members', async () => {
    const response = await get(billing, `${INTERNAL_ACCOUNTS_PATH}/${accountId}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), record());
    assert.equal((await get(billing, `${INTERNAL_ACCOUNTS_PATH}/${unknownId}`)).status, 404);
    assert.equal((await get(billing, `${INTERNAL_ACCOUNTS_PATH}/not-a-uuid`)).status, 404);
});

test('the billing service places and lifts Holds; both are idempotent', async () => {
    const hold = `${INTERNAL_ACCOUNTS_PATH}/${accountId}/holds/payment-method`;
    for (const _ of [1, 2]) {
        const placed = await get(billing, hold, 'PUT');
        assert.equal(placed.status, 204);
        assert.equal(await placed.text(), '');
    }
    assert.deepEqual([...holds], ['payment-method']);
    assert.equal((await get(billing, hold, 'DELETE')).status, 204);
    assert.equal((await get(billing, hold, 'DELETE')).status, 204);
    assert.deepEqual([...holds], []);
    assert.equal((await get(billing, `${INTERNAL_ACCOUNTS_PATH}/${unknownId}/holds/payment-method`, 'PUT')).status, 404);
    assert.equal((await get(billing, `${INTERNAL_ACCOUNTS_PATH}/${accountId}/holds/Not_A_Label`, 'PUT')).status, 404);
    const post = await get(billing, hold, 'POST');
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'PUT, DELETE');
});

test('the Routes operator gets the routing table', async () => {
    const response = await get(routesOperator, INTERNAL_ROUTES_PATH);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), routings);
});

test('each caller only gets its own routes', async () => {
    assert.equal((await get(operator, INTERNAL_ROUTES_PATH)).status, 403);
    assert.equal((await get(routesOperator)).status, 403);
    assert.equal((await get(operator, `${INTERNAL_ACCOUNTS_PATH}/${accountId}`)).status, 403);
    assert.equal((await get(operator, `${INTERNAL_ACCOUNTS_PATH}/${accountId}/holds/unpaid`, 'DELETE')).status, 403);
    assert.equal((await get(billing)).status, 403);
    assert.deepEqual([...holds], []);
});
