import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Credentials, readCredentials, writeCredentials } from './credentials.js';
import { apiAccess } from './session.js';

const stored: Credentials = {
    apiUrl: 'https://api.test',
    issuer: 'https://auth.test',
    clientId: 'mc_cli',
    refreshToken: 'rt1',
    accessToken: 'at1',
    accessTokenExpiresAt: 1_000_000,
};
const newPath = async () => join(await mkdtemp(join(tmpdir(), 'oup-')), 'openupstream', 'credentials.json');

/** madAuth's discovery and token endpoints; `onToken` sees the stored file when the refresh arrives. */
const madauth = (onToken: () => Promise<void> = async () => undefined) =>
    (async (url: unknown) => {
        if (String(url).endsWith('/.well-known/openid-configuration')) {
            return Response.json({ token_endpoint: 'https://auth.test/auth/oidc/token', device_authorization_endpoint: 'https://auth.test/auth/oidc/device' });
        }
        await onToken();
        return Response.json({ access_token: 'at2', refresh_token: 'rt2', expires_in: 900 });
    }) as typeof fetch;

test('the stored file is the owner\'s only; none stored means not signed in', async () => {
    const path = await newPath();
    assert.equal(await readCredentials(path), undefined);
    assert.deepEqual(await apiAccess(path, {}), { ok: false, error: 'not signed in: run oup login (or set OUP_API_KEY)' });
    await writeCredentials(path, stored);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readCredentials(path), stored);
});

test('a fresh access token is used as it is', async () => {
    const path = await newPath();
    await writeCredentials(path, stored);
    assert.deepEqual(await apiAccess(path, {}, { now: () => 0, fetch: madauth() }), { ok: true, value: { apiUrl: 'https://api.test', token: 'at1' } });
});

test('an expiring one is refreshed, and the new refresh token is stored before the access token is used', async () => {
    const path = await newPath();
    await writeCredentials(path, stored);
    const result = await apiAccess(path, {}, { now: () => 990_000, fetch: madauth() });
    assert.deepEqual(result, { ok: true, value: { apiUrl: 'https://api.test', token: 'at2' } });
    const after = await readCredentials(path);
    assert.equal(after?.refreshToken, 'rt2');
    assert.equal(after?.accessTokenExpiresAt, 990_000 + 900_000);
});

test('two processes refreshing at once use the refresh token once: the second finds the first one\'s tokens', async () => {
    const path = await newPath();
    await writeCredentials(path, stored);
    let refreshes = 0;
    const fetcher = madauth(async () => {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const deps = { now: () => 990_000, fetch: fetcher, sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms / 20)) };
    const [first, second] = await Promise.all([apiAccess(path, {}, deps), apiAccess(path, {}, deps)]);
    assert.equal(refreshes, 1);
    assert.deepEqual([first, second].map((r) => r.ok && r.value.token), ['at2', 'at2']);
});

test('OUP_API_KEY needs no sign-in', async () => {
    assert.deepEqual(await apiAccess(await newPath(), { OUP_API_KEY: 'madauth_x', OUP_API_URL: 'https://api.dev.test' }), {
        ok: true,
        value: { apiUrl: 'https://api.dev.test', token: 'madauth_x' },
    });
});
