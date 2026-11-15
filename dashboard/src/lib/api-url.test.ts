import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiUrlFor } from './api-url';

test('the API is at api.<the dashboard hostname> unless the build names another', () => {
    assert.equal(apiUrlFor({ protocol: 'https:', host: 'openupstream.com' }, undefined), 'https://api.openupstream.com');
    assert.equal(apiUrlFor({ protocol: 'https:', host: 'dev.example.org' }, ''), 'https://api.dev.example.org');
    assert.equal(apiUrlFor({ protocol: 'http:', host: 'localhost:3000' }, 'http://localhost:8080/'), 'http://localhost:8080');
});
