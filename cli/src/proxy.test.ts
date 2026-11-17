import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type AddressInfo, type Server, connect, createServer } from 'node:net';
import { type Server as HttpServer, createServer as createHttpServer } from 'node:http';
import { WebSocketServer, createWebSocketStream } from 'ws';
import { connectionUrl, listen, openTunnel, parseAccess, parsePort, portFree, prepareRole, serveTunnel, tunnelErrorMessage } from './proxy.js';
import { ok } from './result.js';

test('--access is read by default, one of the three levels otherwise', () => {
    assert.deepEqual(parseAccess(undefined), { ok: true, value: 'read' });
    assert.deepEqual(parseAccess('owner'), { ok: true, value: 'owner' });
    assert.deepEqual(parseAccess('admin'), { ok: false, error: '--access is one of read, write, owner' });
});

test('--port is 5432 by default, a port number otherwise', () => {
    assert.deepEqual(parsePort(undefined), { ok: true, value: 5432 });
    assert.deepEqual(parsePort('5433'), { ok: true, value: 5433 });
    for (const bad of ['0', '65536', '54.3', 'x']) {
        assert.equal(parsePort(bad).ok, false, bad);
    }
});

test('the connection URL points at 127.0.0.1 without TLS, which the tunnel already has', () => {
    assert.equal(
        connectionUrl({ user: 'oup_read_ab', password: 'A-b_c', database: 'app' }, 5433),
        'postgres://oup_read_ab:A-b_c@127.0.0.1:5433/app?sslmode=disable',
    );
});

/**
 * A stand-in for Traefik and the forwarder: answers `status` for any other
 * token than `good`, and upper-cases the bytes of every tunnel.
 */
let tunnelServer: HttpServer;
let tunnelUrl: string;
let status = 401;
const authorizations: string[] = [];

before(async () => {
    const sockets = new WebSocketServer({ noServer: true });
    tunnelServer = createHttpServer();
    tunnelServer.on('upgrade', (req, socket, head) => {
        authorizations.push(req.headers.authorization ?? '');
        if (req.headers.authorization !== 'Bearer good') {
            socket.end(`HTTP/1.1 ${status} No\r\ncontent-length: 0\r\n\r\n`);
            return;
        }
        sockets.handleUpgrade(req, socket, head, (ws) => {
            const stream = createWebSocketStream(ws);
            stream.on('data', (chunk: Buffer) => stream.write(Buffer.from(chunk.toString().toUpperCase())));
        });
    });
    tunnelServer.listen(0, '127.0.0.1');
    await once(tunnelServer, 'listening');
    tunnelUrl = `ws://127.0.0.1:${(tunnelServer.address() as AddressInfo).port}/databases/x/pooler`;
});

after(() => {
    tunnelServer.closeAllConnections();
    tunnelServer.close();
});

test('a refused tunnel says why and is final; another status is worth a retry', async () => {
    for (const [code, kind] of [
        [401, 'refused'],
        [403, 'refused'],
        [404, 'refused'],
        [502, 'unavailable'],
    ] as const) {
        status = code;
        const opened = await openTunnel(tunnelUrl, 'bad');
        assert.ok(!opened.ok);
        assert.equal(opened.error.kind, kind, String(code));
    }
    assert.equal(tunnelErrorMessage({ kind: 'refused', status: 401 }), 'the tunnel refused your sign-in (401): run oup login again');
    const unreachable = await openTunnel('ws://127.0.0.1:1/databases/x/pooler', 'good');
    assert.ok(!unreachable.ok && unreachable.error.kind === 'unavailable');
});

test('every local connection gets a tunnel of its own with a fresh token, and its bytes go both ways', async () => {
    const server = createServer();
    let tokens = 0;
    serveTunnel(server, {
        url: tunnelUrl,
        token: async () => {
            tokens += 1;
            return ok('good');
        },
        warn: () => undefined,
    });
    const port = await listen(server, 0);
    assert.ok(port.ok);
    const talk = async () => {
        const socket = connect(port.value, '127.0.0.1');
        await once(socket, 'connect');
        socket.write('select 1');
        const [reply] = (await once(socket, 'data')) as [Buffer];
        socket.destroy();
        return reply.toString();
    };
    assert.deepEqual(await Promise.all([talk(), talk()]), ['SELECT 1', 'SELECT 1']);
    assert.equal(tokens, 2);
    server.close();
});

test('a connection whose tunnel is refused is closed and reported', async () => {
    status = 401;
    const server = createServer();
    const warnings: string[] = [];
    serveTunnel(server, { url: tunnelUrl, token: async () => ok('bad'), warn: (message) => warnings.push(message) });
    const port = await listen(server, 0);
    assert.ok(port.ok);
    const socket = connect(port.value, '127.0.0.1');
    await once(socket, 'close');
    assert.deepEqual(warnings, ['a connection could not be carried: the tunnel refused your sign-in (401): run oup login again']);
    server.close();
});

test('a taken port is reported before anything else', async () => {
    const taken: Server = createServer();
    const port = await listen(taken, 0);
    assert.ok(port.ok);
    const free = await portFree(port.value);
    assert.deepEqual(free, { ok: false, error: `port ${port.value} is taken (a Postgres of your own?); choose another with --port` });
    taken.close();
    assert.deepEqual(await portFree(port.value), { ok: true, value: undefined });
    // Neither of listen's own listeners stays behind to swallow a later error.
    assert.equal(taken.listenerCount('error'), 0);
    assert.equal(taken.listenerCount('listening'), 0);
});

test('preparing the role stops at once when the tunnel refuses the caller', async () => {
    status = 403;
    const reports: string[] = [];
    const prepared = await prepareRole({
        url: tunnelUrl,
        token: async () => ok('bad'),
        warn: () => undefined,
        report: (message) => reports.push(message),
        proxy: { access: 'owner', user: 'oup_owner_x', password: 'p', database: 'app', tunnelUrl },
    });
    assert.deepEqual(prepared, { ok: false, error: 'the tunnel refused you (403): an API key needs openupstream:write' });
    assert.deepEqual(reports, []);
});

test('a tunnel that is not there yet is waited for, then reported when the time is up', async () => {
    const reports: string[] = [];
    const prepared = await prepareRole({
        url: 'ws://127.0.0.1:1/databases/x/pooler',
        token: async () => ok('good'),
        warn: () => undefined,
        report: (message) => reports.push(message),
        proxy: { access: 'read', user: 'oup_read_x', password: 'p', database: 'app', tunnelUrl },
        waitMs: 50,
        retryMs: 10,
    });
    assert.ok(!prepared.ok);
    assert.match(prepared.error, /^the tunnel is not reachable/);
    assert.equal(reports.length, 1);
});
