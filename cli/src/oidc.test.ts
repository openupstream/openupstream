import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_CODE_GRANT, type Discovery, SCOPE, emailOf, refresh, startDeviceSignIn, waitForApproval } from './oidc.js';

const discovery: Discovery = {
    tokenEndpoint: 'https://auth.test/auth/oidc/token',
    deviceAuthorizationEndpoint: 'https://auth.test/auth/oidc/device',
    endSessionEndpoint: undefined,
};
const device = { deviceCode: 'dc', userCode: 'BCDF-GHJK', verificationUri: 'https://auth.test/', verificationUriComplete: 'https://auth.test/?madauth_device=BCDF-GHJK', expiresIn: 600, interval: 5 };

/** A token endpoint answering `replies` in turn; records the forms and the waits. */
const fake = (replies: { status: number; body: unknown }[]) => {
    const forms: Record<string, string>[] = [];
    const waits: number[] = [];
    let clock = 0;
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
        forms.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
        const reply = replies.shift() ?? { status: 500, body: {} };
        return Response.json(reply.body, { status: reply.status });
    }) as typeof fetch;
    const deps = { fetch: fetcher, now: () => clock, sleep: async (ms: number) => void (waits.push(ms), (clock += ms)) };
    return { forms, waits, deps };
};
const tokens = { access_token: 'at', refresh_token: 'rt', id_token: 'h.eyJlbWFpbCI6ImFAYi50ZXN0In0.s', expires_in: 900 };

test('asks for a device code with offline_access, so a refresh token comes', async () => {
    const { forms, deps } = fake([{ status: 200, body: { device_code: 'dc', user_code: 'BCDF-GHJK', verification_uri: 'https://auth.test/', verification_uri_complete: 'https://auth.test/?madauth_device=BCDF-GHJK', expires_in: 600, interval: 5 } }]);
    const started = await startDeviceSignIn(discovery, 'mc_cli', deps);
    assert.deepEqual(started, { ok: true, value: device });
    assert.deepEqual(forms, [{ client_id: 'mc_cli', scope: SCOPE }]);
    assert.match(SCOPE, /offline_access/);
});

test('polls every interval while pending, five seconds slower after slow_down, until approved', async () => {
    const { forms, waits, deps } = fake([
        { status: 400, body: { error: 'authorization_pending' } },
        { status: 400, body: { error: 'slow_down' } },
        { status: 400, body: { error: 'authorization_pending' } },
        { status: 200, body: tokens },
    ]);
    const result = await waitForApproval(discovery, 'mc_cli', device, deps);
    assert.deepEqual(result, { ok: true, value: { accessToken: 'at', refreshToken: 'rt', idToken: tokens.id_token, expiresAt: 30_000 + 900_000 } });
    assert.deepEqual(waits, [5000, 5000, 10_000, 10_000]);
    assert.deepEqual(forms[0], { grant_type: DEVICE_CODE_GRANT, device_code: 'dc', client_id: 'mc_cli' });
});

test('a denied or expired code ends the sign-in with a message', async () => {
    assert.deepEqual(await waitForApproval(discovery, 'c', device, fake([{ status: 400, body: { error: 'access_denied' } }]).deps), {
        ok: false,
        error: 'the sign-in was denied',
    });
    assert.deepEqual(await waitForApproval(discovery, 'c', device, fake([{ status: 400, body: { error: 'expired_token' } }]).deps), {
        ok: false,
        error: 'the code expired; run oup login again',
    });
    const forever = fake(Array.from({ length: 200 }, () => ({ status: 400, body: { error: 'authorization_pending' } })));
    assert.deepEqual(await waitForApproval(discovery, 'c', device, forever.deps), { ok: false, error: 'the code expired; run oup login again' });
});

test('without a refresh token (no offline_access) the sign-in is not taken', async () => {
    const result = await waitForApproval(discovery, 'c', device, fake([{ status: 200, body: { access_token: 'at' } }]).deps);
    assert.equal(result.ok, false);
});

test('a refresh gives new tokens; a used or ended refresh token means signing in again', async () => {
    const renewed = await refresh(discovery, 'mc_cli', 'rt', fake([{ status: 200, body: { ...tokens, refresh_token: 'rt2' } }]).deps);
    assert.equal(renewed.ok && renewed.value.refreshToken, 'rt2');
    const ended = await refresh(discovery, 'mc_cli', 'rt', fake([{ status: 400, body: { error: 'invalid_grant' } }]).deps);
    assert.equal(ended.ok ? 'ok' : ended.error.kind, 'signed-out');
    const down = await refresh(discovery, 'mc_cli', 'rt', fake([{ status: 503, body: {} }]).deps);
    assert.equal(down.ok ? 'ok' : down.error.kind, 'unavailable');
});

test("the ID token's e-mail, and nothing for a malformed one", () => {
    assert.equal(emailOf(tokens.id_token), 'a@b.test');
    assert.equal(emailOf('a.!!!.c'), undefined);
    assert.equal(emailOf(undefined), undefined);
});
