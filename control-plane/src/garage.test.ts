import { test } from 'node:test';
import assert from 'node:assert/strict';
import { garageStorage } from './garage.js';

interface Seen {
    method: string;
    path: string;
    auth: string | null;
    body: unknown;
}

/** Garage's admin API, answering from `routes` by method and path without the query; anything else is 404. */
const fakeAdmin = (routes: Record<string, { status: number; body?: unknown }>, seen: Seen[]) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const method = init?.method ?? 'GET';
        seen.push({
            method,
            path: `${url.pathname}${url.search}`,
            auth: new Headers(init?.headers).get('authorization'),
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
        });
        const answer = routes[`${method} ${url.pathname}`] ?? { status: 404, body: { code: 'NoSuchBucket', message: 'not found' } };
        return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), { status: answer.status });
    }) as typeof fetch;

const config = { adminUrl: 'http://garage.test:3903', adminToken: 'admin-token', s3Url: 'http://garage.test:3900' };
const key = { accessKeyId: 'GK1', name: 'bucket-shop', expired: false, permissions: {}, buckets: [], secretAccessKey: 'shh' };

test('a bucket is its alias, a key of its own and read-write for that key only, with the admin token', async () => {
    const seen: Seen[] = [];
    const garage = garageStorage(config, {
        fetch: fakeAdmin(
            {
                'POST /v2/CreateBucket': { status: 200, body: { id: 'b1' } },
                'POST /v2/CreateKey': { status: 200, body: key },
                'POST /v2/AllowBucketKey': { status: 200, body: { id: 'b1' } },
            },
            seen,
        ),
    });
    assert.deepEqual(await garage.createBucket('shop'), { ok: true, value: { bucketId: 'b1', accessKeyId: 'GK1' } });
    assert.deepEqual(
        seen.map(({ method, path, body }) => [method, path, body]),
        [
            ['POST', '/v2/CreateBucket', { globalAlias: 'shop' }],
            ['POST', '/v2/CreateKey', { name: 'bucket-shop', neverExpires: true }],
            ['POST', '/v2/AllowBucketKey', { bucketId: 'b1', accessKeyId: 'GK1', permissions: { read: true, write: true, owner: false } }],
        ],
    );
    assert.ok(seen.every((call) => call.auth === 'Bearer admin-token'));
});

test('a taken alias is name-taken; a failure halfway undoes the bucket so the name is free', async () => {
    const taken = garageStorage(config, {
        fetch: fakeAdmin({ 'POST /v2/CreateBucket': { status: 409, body: { code: 'BucketAlreadyExists', message: 'exists' } } }, []),
    });
    assert.deepEqual(await taken.createBucket('shop'), { ok: false, error: { kind: 'name-taken' } });

    const seen: Seen[] = [];
    const halfway = garageStorage(config, {
        fetch: fakeAdmin(
            {
                'POST /v2/CreateBucket': { status: 200, body: { id: 'b1' } },
                'POST /v2/CreateKey': { status: 200, body: key },
                'POST /v2/AllowBucketKey': { status: 500, body: { code: 'InternalError', message: 'quorum' } },
                'POST /v2/DeleteKey': { status: 200 },
                'POST /v2/DeleteBucket': { status: 200 },
            },
            seen,
        ),
    });
    assert.deepEqual(await halfway.createBucket('shop'), {
        ok: false,
        error: { kind: 'unavailable', reason: 'Garage answered 500 InternalError: quorum' },
    });
    assert.deepEqual(seen.slice(3).map(({ path }) => path), ['/v2/DeleteKey?id=GK1', '/v2/DeleteBucket?id=b1']);
});

test("a key's secret is shown again; Garage unreachable is an error, not an exception", async () => {
    const seen: Seen[] = [];
    const garage = garageStorage(config, { fetch: fakeAdmin({ 'GET /v2/GetKeyInfo': { status: 200, body: key } }, seen) });
    assert.deepEqual(await garage.secretOf('GK1'), { ok: true, value: 'shh' });
    assert.equal(seen[0]?.path, '/v2/GetKeyInfo?id=GK1&showSecretKey=true');

    const down = garageStorage(config, {
        fetch: (async () => {
            throw new Error('ECONNREFUSED');
        }) as typeof fetch,
    });
    assert.deepEqual(await down.secretOf('GK1'), { ok: false, error: 'Garage unreachable: ECONNREFUSED' });
});

test('deleting removes the key first; a bucket that is already gone counts as deleted', async () => {
    const seen: Seen[] = [];
    const garage = garageStorage(config, { fetch: fakeAdmin({}, seen) });
    assert.deepEqual(await garage.deleteBucket({ bucketId: 'b1', accessKeyId: 'GK1' }), { ok: true, value: 0 });
    assert.deepEqual(seen.map(({ path }) => path), ['/v2/DeleteKey?id=GK1', '/v2/GetBucketInfo?id=b1']);

    const failing = garageStorage(config, {
        fetch: fakeAdmin({ 'POST /v2/DeleteKey': { status: 503, body: { code: 'NoQuorum', message: 'try again' } } }, []),
    });
    assert.deepEqual(await failing.deleteBucket({ bucketId: 'b1', accessKeyId: 'GK1' }), {
        ok: false,
        error: 'Garage answered 503 NoQuorum: try again',
    });
});
