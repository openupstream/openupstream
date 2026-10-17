import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configFrom } from './config.js';

const env = {
    DATABASE_URL: 'postgres://app@db/app',
    AUTH_ISSUER: 'https://auth.openupstream.com',
    AUTH_AUDIENCE: 'openupstream-api',
    AUTH_JWKS_URL: 'https://auth.openupstream.com/.well-known/jwks.json',
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
    assert.deepEqual(config.value.auth, {
        issuer: env.AUTH_ISSUER,
        audience: env.AUTH_AUDIENCE,
        jwksUrl: env.AUTH_JWKS_URL,
    });
    assert.equal(config.value.cleanupIntervalMs, 30_000);
});

test('every problem is reported at once', () => {
    const config = configFrom({ AUTH_JWKS: '{"keys":[]}', AUTH_JWKS_URL: 'https://x', BACKUP_RETENTION: '1w', PORT: 'http' });
    assert.deepEqual(config.ok ? [] : config.error, [
        'DATABASE_URL is not set',
        'AUTH_ISSUER is not set',
        'AUTH_AUDIENCE is not set',
        'set exactly one of AUTH_JWKS_URL and AUTH_JWKS',
        'BACKUP_BUCKET is not set',
        'ACCESS_KEY_ID is not set',
        'ACCESS_SECRET_KEY is not set',
        'BACKUP_RETENTION must be days, e.g. 30d',
        'PORT and INTERNAL_PORT must be port numbers',
    ]);
});

test('an inline JWKS must be a JWKS document, a JWKS URL a URL', () => {
    const { AUTH_JWKS_URL: _url, ...rest } = env;
    const bad = configFrom({ ...rest, AUTH_JWKS: '{"keys": ' });
    assert.deepEqual(bad.ok ? [] : bad.error, ['AUTH_JWKS must be a JWKS document: {"keys": [...]}']);
    assert.equal(configFrom({ ...rest, AUTH_JWKS: '{"keys":[]}' }).ok, true);
    const url = configFrom({ ...env, AUTH_JWKS_URL: 'jwks.json' });
    assert.deepEqual(url.ok ? [] : url.error, ['AUTH_JWKS_URL must be a URL']);
});
