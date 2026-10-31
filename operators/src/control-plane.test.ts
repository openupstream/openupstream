import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INTERNAL_DATABASES_PATH, PLATFORM } from '@openupstream/sdk';
import { controlPlaneRows, parseRoutings, parseRows } from './control-plane.js';

const rows = [{ project: PLATFORM.project, database: PLATFORM.database }];

let server: Server;
let base: string;
let reply: { status: number; body: string } = { status: 200, body: JSON.stringify(rows) };
const seen: { path: string | undefined; authorization: string | undefined }[] = [];

before(async () => {
    server = createServer((req, res) => {
        seen.push({ path: req.url, authorization: req.headers.authorization });
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.body);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
    server.close();
});

test('rows come from the internal API with the current token, read on every call', async () => {
    const tokens = ['first\n', 'rotated\n'];
    const fetchRows = controlPlaneRows(base, async () => tokens.shift() ?? '');
    seen.length = 0;
    reply = { status: 200, body: JSON.stringify(rows) };
    assert.deepEqual(await fetchRows(), { ok: true, value: rows });
    await fetchRows();
    assert.deepEqual(seen, [
        { path: INTERNAL_DATABASES_PATH, authorization: 'Bearer first' },
        { path: INTERNAL_DATABASES_PATH, authorization: 'Bearer rotated' },
    ]);
});

test('a refusal is reported with its status', async () => {
    reply = { status: 403, body: '{"error":"caller not allowed"}' };
    const result = await controlPlaneRows(base, async () => 't')();
    assert.deepEqual(result, { ok: false, error: { kind: 'status', status: 403, body: '{"error":"caller not allowed"}' } });
});

test('a body that is not a list of rows is malformed', async () => {
    reply = { status: 200, body: '{"rows": []}' };
    assert.equal((await controlPlaneRows(base, async () => 't')()).ok, false);
    reply = { status: 200, body: 'not json' };
    const result = await controlPlaneRows(base, async () => 't')();
    assert.equal(!result.ok && result.error.kind, 'malformed');
});

test('an unreachable control plane or unreadable token is reported, not thrown', async () => {
    const down = await controlPlaneRows('http://127.0.0.1:1', async () => 't')();
    assert.equal(!down.ok && down.error.kind, 'unreachable');
    assert.match(!down.ok && down.error.kind === 'unreachable' ? down.error.message : '', /^fetch failed: .+/);
    const noToken = await controlPlaneRows(base, () => Promise.reject(new Error('ENOENT')))();
    assert.deepEqual(noToken, { ok: false, error: { kind: 'unreachable', message: 'ENOENT' } });
});

test('only the shape is checked; rows that cannot run are the manifests’ to judge', () => {
    assert.equal(parseRows([]).ok, true);
    assert.equal(parseRows([{ project: { id: 'p' }, database: { id: 'd', memoryMb: 1 } }]).ok, true);
    assert.equal(parseRows([{ project: { id: 'p' } }]).ok, false);
    assert.equal(parseRows([{ project: null, database: { id: 'd' } }]).ok, false);
    assert.equal(parseRows(null).ok, false);
});

test('the routing table is checked for its shape', () => {
    const routing = {
        projectId: 'p',
        projectName: 'shop',
        domainId: 'd',
        hostname: 'shop-a1b2c3d4.openupstream.app',
        routes: [{ id: 'r', pathPrefix: '/', bucketName: 'shop-site', spaFallback: false }],
    };
    assert.deepEqual(parseRoutings([routing]), { ok: true, value: [routing] });
    assert.equal(parseRoutings([{ ...routing, routes: [{ id: 'r' }] }]).ok, false);
    assert.equal(parseRoutings({}).ok, false);
});
