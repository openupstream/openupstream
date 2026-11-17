import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { type Server as TcpServer, createServer as createTcpServer } from 'node:net';
import type { Server } from 'node:http';
import { WebSocket } from 'ws';
import { createForwarder, targetOf } from './forwarder.js';

const DATABASE = '5d1c2a33-90b4-4c8f-8f3e-6c2b9d0e7f44';
const NAMESPACE = 'project-0b8e6c9e-7a4f-4e39-9a7e-1f3f0d6f2a11';

test("a tunnel's path leads to the Database's Pooler or its primary in the Project's namespace, nothing else", () => {
    assert.deepEqual(targetOf(`/databases/${DATABASE}/pooler`, NAMESPACE), { host: `db-${DATABASE}-pooler.${NAMESPACE}.svc.cluster.local`, port: 5432 });
    assert.deepEqual(targetOf(`/databases/${DATABASE}/primary`, NAMESPACE), { host: `db-${DATABASE}-rw.${NAMESPACE}.svc.cluster.local`, port: 5432 });
    for (const path of ['/', `/databases/${DATABASE}`, `/databases/${DATABASE}/replica`, `/databases/${DATABASE}/pooler/`, '/databases/../x/pooler', `/databases/${DATABASE.toUpperCase()}/pooler`]) {
        assert.equal(targetOf(path, NAMESPACE), undefined, path);
    }
});

let echo: TcpServer;
let forwarder: Server;
let url: string;
const logs: Record<string, unknown>[] = [];

before(async () => {
    // Stands in for PgBouncer: answers every chunk with the same bytes, upper-cased.
    echo = createTcpServer((socket) => socket.on('data', (chunk) => socket.write(Buffer.from(chunk.toString().toUpperCase()))));
    echo.listen(0, '127.0.0.1');
    await once(echo, 'listening');
    const echoPort = (echo.address() as AddressInfo).port;
    forwarder = createForwarder({
        resolve: (path) => (targetOf(path, NAMESPACE) === undefined ? undefined : { host: '127.0.0.1', port: echoPort }),
        log: (entry) => logs.push(entry),
    });
    forwarder.listen(0, '127.0.0.1');
    await once(forwarder, 'listening');
    url = `ws://127.0.0.1:${(forwarder.address() as AddressInfo).port}`;
});

after(async () => {
    forwarder.closeAllConnections();
    forwarder.close();
    echo.close();
});

test('bytes go both ways through a tunnel, and closing it closes the database connection', async () => {
    const ws = new WebSocket(`${url}/databases/${DATABASE}/pooler`);
    await once(ws, 'open');
    ws.send(Buffer.from('select 1'));
    const [reply] = (await once(ws, 'message')) as [Buffer];
    assert.equal(reply.toString(), 'SELECT 1');
    ws.close();
    await once(ws, 'close');
    while (!logs.some((entry) => entry['msg'] === 'tunnel closed')) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const closed = logs.find((entry) => entry['msg'] === 'tunnel closed');
    assert.equal(closed?.['bytesToDatabase'], 8);
    assert.equal(closed?.['bytesFromDatabase'], 8);
});

test('another path is refused before any upgrade', async () => {
    const ws = new WebSocket(`${url}/databases/${DATABASE}/replica`);
    const [, response] = (await once(ws, 'unexpected-response')) as [unknown, { statusCode: number }];
    assert.equal(response.statusCode, 404);
});

test('the readiness probe gets 200, any other request 404', async () => {
    assert.equal((await fetch(`${url.replace('ws:', 'http:')}/healthz`)).status, 200);
    assert.equal((await fetch(`${url.replace('ws:', 'http:')}/databases/${DATABASE}/pooler`)).status, 404);
});
