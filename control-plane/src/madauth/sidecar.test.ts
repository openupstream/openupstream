import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { signWebhook } from '@madauth/server/webhook';
import { type MailRequest, apiKeyScopes, createSidecar, signupAllowList, signupAllowed } from './sidecar.js';

const secret = `whsec_${randomBytes(32).toString('base64')}`;
const NOW = 1_800_000_000;
let ids = 0;

/** Signs as madAuth does, with its own function; a fresh id per call unless given. */
const sign = (body: string, { id = `msg_${(ids += 1)}`, timestamp = NOW, key = secret } = {}) => ({
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': signWebhook(key, id, timestamp, body),
});

const sidecar = (sendMail?: (mail: MailRequest) => Promise<{ ok: true; value: undefined } | { ok: false; error: string }>) => {
    const logs: Record<string, unknown>[] = [];
    const app = createSidecar({ webhookSecret: secret, sendMail, log: (entry) => logs.push(entry), now: () => NOW * 1000 });
    const post = (call: unknown, headers?: Record<string, string>) => {
        const body = JSON.stringify(call);
        return app.request('/webhooks', { method: 'POST', body, headers: headers ?? sign(body) });
    };
    return { app, logs, post };
};

const verification = {
    type: 'email.send_verification',
    data: { to: 'dora@example.test', link: 'https://openupstream.com/?madauth_token=t', code: '123456', site: 'openupstream.com' },
};

test("the API key scopes are what madAuth accepts: names, descriptions, never madauth's own", async () => {
    const response = await sidecar().app.request('/api-key-scopes');
    assert.deepEqual(await response.json(), apiKeyScopes);
    for (const scope of apiKeyScopes.scopes) {
        assert.match(scope.name, /^[a-z0-9_-]+(:[a-z0-9_-]+)*$/);
        assert.ok(scope.name.length <= 64 && !scope.name.startsWith('madauth:'));
        assert.ok(scope.description.length <= 200);
    }
    assert.deepEqual(
        apiKeyScopes.scopes.map((s) => s.name),
        ['openupstream:read', 'openupstream:write'],
    );
});

test('an e-mail is handed to the sender with its link and code', async () => {
    const sent: MailRequest[] = [];
    const { post } = sidecar(async (mail) => {
        sent.push(mail);
        return { ok: true, value: undefined };
    });
    assert.equal((await post(verification)).status, 200);
    assert.equal(sent[0]?.to, 'dora@example.test');
    assert.equal(sent[0]?.data['code'], '123456');
});

test('without a mail sender, or when sending fails, e-mails are refused so madAuth reports it', async () => {
    assert.equal((await sidecar().post(verification)).status, 503);
    const failing = sidecar(async () => ({ ok: false, error: 'provider down' }));
    assert.equal((await failing.post(verification)).status, 503);
    assert.equal(failing.logs[0]?.['error'], 'provider down');
});

test('events are acknowledged', async () => {
    assert.equal((await sidecar().post({ type: 'user.signed_up', data: { user: { id: 'usr_1' } } })).status, 204);
});

test('unsigned, forged, stale or tampered calls are refused', async () => {
    const { post } = sidecar(async () => ({ ok: true, value: undefined }));
    const body = JSON.stringify(verification);
    assert.equal((await post(verification, {})).status, 401);
    assert.equal((await post(verification, sign(body, { key: `whsec_${randomBytes(32).toString('base64')}` }))).status, 401);
    assert.equal((await post(verification, sign(body, { timestamp: NOW - 301 }))).status, 401);
    assert.equal((await post({ ...verification, data: { ...verification.data, to: 'evil@x.test' } }, sign(body))).status, 401);
});

test('a replayed call is refused, even with a valid signature', async () => {
    const { post } = sidecar(async () => ({ ok: true, value: undefined }));
    const body = JSON.stringify(verification);
    const headers = sign(body, { id: 'msg_replay' });
    assert.equal((await post(verification, headers)).status, 200);
    assert.equal((await post(verification, headers)).status, 409);
});

test('a signed body that is not {type, data} is a 400, not a crash', async () => {
    const { app } = sidecar();
    for (const body of ['not json', '[]', '{"data":{}}']) {
        const response = await app.request('/webhooks', { method: 'POST', body, headers: sign(body) });
        assert.equal(response.status, 400, body);
    }
});

const signingUp = (email: string) => ({ type: 'user.signing_up', data: { email, name: 'Dora', locale: 'en', method: 'password' } });

test('while sign-up is open, every new user is allowed', async () => {
    const response = await sidecar().post(signingUp('dora@example.test'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { allow: true });
});

test('while sign-up is closed, only the allowed addresses and domains get in, and the rest see the message', async () => {
    const logs: Record<string, unknown>[] = [];
    const app = createSidecar({
        webhookSecret: secret,
        sendMail: undefined,
        signup: { open: false, allow: signupAllowList(' Maintainer@Example.test, @team.example.test,'), message: 'Not open yet.' },
        log: (entry) => logs.push(entry),
        now: () => NOW * 1000,
    });
    const answer = async (call: unknown) => {
        const body = JSON.stringify(call);
        const response = await app.request('/webhooks', { method: 'POST', body, headers: sign(body) });
        assert.equal(response.status, 200);
        return response.json();
    };
    assert.deepEqual(await answer(signingUp('maintainer@example.test')), { allow: true });
    assert.deepEqual(await answer(signingUp('MAINTAINER@example.TEST')), { allow: true });
    assert.deepEqual(await answer(signingUp('anyone@team.example.test')), { allow: true });
    assert.deepEqual(await answer(signingUp('dora@example.test')), { allow: false, message: 'Not open yet.' });
    // A subdomain or a look-alike is not the allowed domain.
    assert.deepEqual(await answer(signingUp('eve@evil.team.example.test')), { allow: false, message: 'Not open yet.' });
    assert.deepEqual(await answer({ type: 'user.signing_up', data: { method: 'github' } }), { allow: false, message: 'Not open yet.' });
    assert.ok(logs.every((entry) => !JSON.stringify(entry).includes('dora@')), 'refused addresses are not logged');
});

test('the allow list ignores case, spaces and empty entries', () => {
    assert.deepEqual(signupAllowList(''), []);
    const policy = { open: false, allow: signupAllowList('A@B.test , ,@c.test'), message: '' } as const;
    assert.deepEqual(policy.allow, ['a@b.test', '@c.test']);
    assert.equal(signupAllowed(policy, ' a@b.TEST '), true);
    assert.equal(signupAllowed(policy, 'x@c.test'), true);
    assert.equal(signupAllowed(policy, 'x@b.test'), false);
    assert.equal(signupAllowed(policy, 'c.test'), false);
    assert.equal(signupAllowed({ open: true }, undefined), true);
});
