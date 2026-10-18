import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configFrom } from './config.js';

const env = {
    DATABASE_URL: 'postgres://app@db/app',
    AUTH_ISSUER: 'https://openupstream.com',
    MADAUTH_URL: 'http://madauth.project-00000000-0000-4000-8000-000000000002.svc:8787',
    BACKUP_BUCKET: 'openupstream-pg-backup',
    ACCESS_KEY_ID: 'id',
    ACCESS_SECRET_KEY: 'secret',
    BACKUP_RETENTION: '30d',
};

test('a complete environment, with defaults for the rest', () => {
    const config = configFrom(env);
    assert.ok(config.ok);
    assert.equal(config.value.port, 8080);
    assert.equal(config.value.internalPort, 8081);
    assert.equal(config.value.backup.endpoint, 'https://nbg1.your-objectstorage.com');
    assert.equal(config.value.backup.retention, '30 days');
    assert.deepEqual(config.value.auth, { issuer: env.AUTH_ISSUER, madauthUrl: env.MADAUTH_URL });
    assert.equal(config.value.cleanupIntervalMs, 30_000);
});

test('every problem is reported at once', () => {
    const config = configFrom({ AUTH_JWKS: '{"keys": ', BACKUP_RETENTION: '1w', PORT: 'http' });
    assert.deepEqual(config.ok ? [] : config.error, [
        'DATABASE_URL is not set',
        'AUTH_ISSUER is not set',
        'MADAUTH_URL is not set',
        'AUTH_JWKS must be a JWKS document: {"keys": [...]}',
        'BACKUP_BUCKET is not set',
        'ACCESS_KEY_ID is not set',
        'ACCESS_SECRET_KEY is not set',
        'BACKUP_RETENTION must be days, e.g. 30d',
        'PORT and INTERNAL_PORT must be port numbers',
    ]);
});

test("an inline JWKS replaces madAuth's; MADAUTH_URL must be a URL", () => {
    const inline = configFrom({ ...env, AUTH_JWKS: '{"keys":[]}' });
    assert.ok(inline.ok);
    assert.equal(inline.value.auth.jwks, '{"keys":[]}');
    const url = configFrom({ ...env, MADAUTH_URL: 'not a url' });
    assert.deepEqual(url.ok ? [] : url.error, ['MADAUTH_URL must be a URL']);
});
