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
    GARAGE_ADMIN_URL: 'http://garage.garage.svc.cluster.local:3903',
    GARAGE_ADMIN_TOKEN: 'admin-token',
    GARAGE_S3_URL: 'http://garage.garage.svc.cluster.local:3900',
    CUSTOMER_DOMAIN: 'openupstream.app',
    PLATFORM_DOMAIN: 'openupstream.com',
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
    assert.deepEqual(config.value.billingCallers, new Set());
    assert.deepEqual(config.value.newAccountHolds, []);
});

test('Garage inside the cluster, the customer domain and the platform domain', () => {
    const config = configFrom(env);
    assert.ok(config.ok);
    assert.deepEqual(config.value.garage, {
        adminUrl: env.GARAGE_ADMIN_URL,
        adminToken: 'admin-token',
        s3Url: env.GARAGE_S3_URL,
    });
    assert.equal(config.value.customerDomain, 'openupstream.app');
    assert.equal(config.value.platformDomain, 'openupstream.com');
    const bad = configFrom({ ...env, GARAGE_S3_URL: 'not a url', CUSTOMER_DOMAIN: 'https://openupstream.app', PLATFORM_DOMAIN: 'Openupstream' });
    assert.deepEqual(bad.ok ? [] : bad.error, [
        'GARAGE_ADMIN_URL and GARAGE_S3_URL must be URLs',
        'CUSTOMER_DOMAIN must be a domain name, e.g. openupstream.app',
        'PLATFORM_DOMAIN must be a domain name, e.g. openupstream.com',
    ]);
});

test('a billing service: its ServiceAccount and the Holds new Accounts start with', () => {
    const config = configFrom({
        ...env,
        BILLING_CALLERS: 'system:serviceaccount:project-x:billing',
        NEW_ACCOUNT_HOLDS: 'payment-method, ',
    });
    assert.ok(config.ok);
    assert.deepEqual(config.value.billingCallers, new Set(['system:serviceaccount:project-x:billing']));
    assert.deepEqual(config.value.newAccountHolds, ['payment-method']);
    const bad = configFrom({ ...env, NEW_ACCOUNT_HOLDS: 'Payment Method' });
    assert.deepEqual(bad.ok ? [] : bad.error, ['NEW_ACCOUNT_HOLDS must be reasons that are DNS labels, e.g. payment-method']);
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
        'GARAGE_ADMIN_URL is not set',
        'GARAGE_S3_URL is not set',
        'GARAGE_ADMIN_TOKEN is not set',
        'CUSTOMER_DOMAIN is not set',
        'PLATFORM_DOMAIN is not set',
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
