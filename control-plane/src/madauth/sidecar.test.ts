import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { type MailRequest, apiKeyScopes, createSidecar, verifyWebhook } from './sidecar.js';

const secret = `whsec_${randomBytes(32).toString('base64')}`;
const NOW = 1_800_000_000;

/** Signs like madAuth: Standard Webhooks. */
const sign = (body: string, { id = 'msg_1', timestamp = NOW, key = secret } = {}) => ({
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${createHmac('sha256', Buffer.from(key.slice(6), 'base64')).update(`${id}.${timestamp}.${body}`).digest('base64')}`,
});

const sidecar = (sendMail?: (mail: MailRequest) => Promise<{ ok: true; value: undefined } | { ok: false; error: string }>) => {
    const logs: Record<string, unknown>[] = [];
    const app = createSidecar({ webhookSecret: secret, sendMail, log: (entry) => logs.push(entry), nowSeconds: () => NOW });
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

test('during a secret rotation, one matching signature among several is enough', () => {
    const body = '{}';
    const old = sign(body, { key: `whsec_${randomBytes(32).toString('base64')}` })['webhook-signature'];
    const current = sign(body)['webhook-signature'];
    assert.equal(
        verifyWebhook(secret, { id: 'msg_1', timestamp: String(NOW), signature: `${old} ${current}` }, body, NOW),
        true,
    );
});
