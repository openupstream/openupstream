import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { compose, sesMail } from './mail.js';

const data = { to: 'dora@example.test', link: 'https://dev.openupstream.com/#madauth_verify=t', code: '123456' };

test('every e-mail madAuth asks for gets a subject and carries its link and code', () => {
    for (const type of ['email.send_verification', 'email.send_password_reset', 'email.send_signin_link']) {
        const message = compose({ type, to: data.to, data });
        assert.ok(message.ok, type);
        assert.ok(message.value.subject.length > 0);
        assert.ok(message.value.text.includes(data.link) && message.value.text.includes(data.code), type);
    }
});

test('the "already registered" and "no password" notes say how the user signs in', () => {
    for (const type of ['email.send_already_registered', 'email.send_password_reset_no_password']) {
        const message = compose({ type, to: data.to, data: { ...data, methods: ['google', 'passkey'] } });
        assert.ok(message.ok && message.value.text.includes('google, passkey'), type);
    }
});

test('a call without its link or code, or of an unknown type, is not written', () => {
    assert.equal(compose({ type: 'email.send_verification', to: data.to, data: { to: data.to } }).ok, false);
    assert.equal(compose({ type: 'email.send_newsletter', to: data.to, data }).ok, false);
});

test('SES gets the message from the configured sender to the recipient', async () => {
    const sent: SendEmailCommand[] = [];
    const send = sesMail({ send: async (command: SendEmailCommand) => sent.push(command) }, 'no-reply@openupstream.com');
    assert.deepEqual(await send({ type: 'email.send_verification', to: data.to, data }), { ok: true, value: undefined });
    const input = sent[0]?.input;
    assert.equal(input?.FromEmailAddress, 'no-reply@openupstream.com');
    assert.deepEqual(input?.Destination?.ToAddresses, ['dora@example.test']);
    assert.match(input?.Content?.Simple?.Subject?.Data ?? '', /Confirm your e-mail/);
});

test('an SES refusal is reported, not thrown, so madAuth answers 503', async () => {
    const send = sesMail(
        {
            send: async () => {
                throw new Error('MessageRejected: Email address is not verified');
            },
        },
        'no-reply@openupstream.com',
    );
    assert.deepEqual(await send({ type: 'email.send_verification', to: data.to, data }), {
        ok: false,
        error: 'SES: MessageRejected: Email address is not verified',
    });
});
