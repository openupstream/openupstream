import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenUpstreamClient } from './index.js';

test('client defaults to the production API', () => {
    const client = new OpenUpstreamClient({ token: 'x' });
    assert.equal(client.baseUrl, 'https://api.openupstream.com');
});
