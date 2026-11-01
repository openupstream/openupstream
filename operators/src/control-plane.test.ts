import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { INTERNAL_DATABASES_PATH, PLATFORM } from '@openupstream/sdk';
import { controlPlaneRows, parseJobRows, parseRoutings, parseRows, parseServiceRows } from './control-plane.js';

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
        kind: 'default',
        routes: [{ id: 'r', pathPrefix: '/', kind: 'bucket', bucketName: 'shop-site', spaFallback: false }],
    };
    assert.deepEqual(parseRoutings([routing]), { ok: true, value: [routing] });
    assert.equal(parseRoutings([{ ...routing, kind: 'other' }]).ok, false);
    assert.equal(parseRoutings([{ ...routing, routes: [{ id: 'r' }] }]).ok, false);
    assert.equal(parseRoutings({}).ok, false);
});

test('Services from the control plane: only rows with an image pinned by digest and a compute Site', () => {
    const row = {
        project: { id: 'p', accountId: 'a', name: 'shop', createdAt: '2026-10-31T00:00:00Z' },
        service: { id: 's', name: 'api', image: 'nginx', imageDigest: `sha256:${'a'.repeat(64)}`, replicas: 1, memoryMb: 128, cpuMillicores: 100, port: 80 },
        pinnedImage: `docker.io/library/nginx@sha256:${'a'.repeat(64)}`,
        site: 'hetzner-fsn1',
        secretsVersion: 'v',
    };
    assert.ok(parseServiceRows([row]).ok);
    assert.equal(parseServiceRows([{ ...row, pinnedImage: 'docker.io/library/nginx:latest' }]).ok, false);
    assert.equal(parseServiceRows([{ ...row, site: 'netcup-nbg' }]).ok, false);
});

test('Jobs from the control plane: only rows with an image pinned by digest, a compute Site and lists of strings', () => {
    const row = {
        project: { id: 'p', accountId: 'a', name: 'shop', createdAt: '2026-10-31T00:00:00Z' },
        job: {
            id: 'j',
            name: 'nightly',
            image: 'nginx',
            imageDigest: `sha256:${'a'.repeat(64)}`,
            command: ['sh', '-c', 'date'],
            args: null,
            memoryMb: 128,
            cpuMillicores: 100,
            timeoutSeconds: 60,
            schedule: null,
            timeZone: null,
        },
        pinnedImage: `docker.io/library/nginx@sha256:${'a'.repeat(64)}`,
        site: 'hetzner-fsn1',
    };
    assert.ok(parseJobRows([row]).ok);
    assert.equal(parseJobRows([{ ...row, pinnedImage: 'docker.io/library/nginx:latest' }]).ok, false);
    assert.equal(parseJobRows([{ ...row, job: { ...row.job, command: [1] } }]).ok, false);
    assert.equal(parseJobRows([{ ...row, job: { ...row.job, schedule: 5 } }]).ok, false);
});
