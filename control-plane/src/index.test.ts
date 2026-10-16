import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './index.js';

test('health endpoint answers', async () => {
    process.env['PORT'] = '0';
    const server = startServer();
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    server.close();
});
