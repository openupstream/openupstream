import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenUpstreamClient, txtRecordName } from './index.js';

test('client defaults to the production API', () => {
    const client = new OpenUpstreamClient({ token: 'x' });
    assert.equal(client.baseUrl, 'https://api.openupstream.com');
});

test('the TXT ownership proof lives under _openupstream', () => {
    assert.equal(txtRecordName('shop.example.com'), '_openupstream.shop.example.com');
});
