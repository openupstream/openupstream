import { after, before, describe, test } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { OpenUpstreamClient, txtRecordName } from './index.js';

test('client defaults to the production API', () => {
    const client = new OpenUpstreamClient({ token: 'x' });
    assert.equal(client.baseUrl, 'https://api.openupstream.com');
});

test('the TXT ownership proof lives under _openupstream', () => {
    assert.equal(txtRecordName('shop.example.com'), '_openupstream.shop.example.com');
});

describe('API calls', () => {
    let server: Server;
    let client: OpenUpstreamClient;
    const seen: { method: string | undefined; url: string | undefined; auth: string | undefined; body: string }[] = [];

    before(async () => {
        server = createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => (body += chunk));
            req.on('end', () => {
                seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
                if (req.url === '/v1/projects' && req.method === 'POST') {
                    res.writeHead(409, { 'content-type': 'application/json' });
                    res.end('{"error":"a Project named shop exists"}');
                } else if (req.method === 'DELETE') {
                    res.writeHead(202);
                    res.end();
                } else if (req.url === '/v1/projects') {
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end('[]');
                } else {
                    res.writeHead(502, { 'content-type': 'text/html' });
                    res.end('<html>bad gateway</html>');
                }
            });
        });
        await new Promise<void>((resolve) => server.listen(0, resolve));
        client = new OpenUpstreamClient({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: 'tok' });
    });

    after(() => {
        server.close();
    });

    test('answers come back as values, with the token sent', async () => {
        assert.deepEqual(await client.listProjects(), { ok: true, value: [] });
        assert.deepEqual(await client.deleteDatabase('p', 'd'), { ok: true, value: undefined });
        assert.equal(seen[0]?.auth, 'Bearer tok');
        assert.equal(seen[1]?.url, '/v1/projects/p/databases/d');
    });

    test("refusals carry the API's message; other failures the status text", async () => {
        assert.deepEqual(await client.createProject({ accountId: 'a', name: 'shop' }), {
            ok: false,
            error: { status: 409, message: 'a Project named shop exists' },
        });
        assert.equal(seen.at(-1)?.body, '{"accountId":"a","name":"shop"}');
        assert.deepEqual(await client.getProject('x'), { ok: false, error: { status: 502, message: 'Bad Gateway' } });
    });

    test('an unreachable API is an error, not an exception', async () => {
        const down = new OpenUpstreamClient({ baseUrl: 'http://127.0.0.1:9', token: 't' });
        const result = await down.listProjects();
        assert.equal(result.ok, false);
        assert.equal(!result.ok && result.error.status, 0);
    });
});
