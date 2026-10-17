/**
 * The madAuth sidecar (ARCHITECTURE.md, decision 63): a second container in
 * the madAuth pod, from the control plane's image. madAuth only calls https
 * or localhost URLs, so what it needs from openupstream is served here, on
 * 127.0.0.1:
 *
 * - `GET /api-key-scopes`: the scopes an API key can have
 *   (API_KEY_SCOPES_URL);
 * - `POST /webhooks`: madAuth's webhook (WEBHOOK_URL). E-mails are handed to
 *   the configured sender; without one they are refused, so a sign-up fails
 *   visibly instead of waiting for an e-mail that never comes. Events are
 *   acknowledged.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { API_KEY_SCOPES } from '@openupstream/sdk';
import { Hono } from 'hono';
import type { Result } from '../result.js';

/** What madAuth reads at API_KEY_SCOPES_URL (its docs/api-keys.md). */
export const apiKeyScopes = {
    scopes: [
        {
            name: API_KEY_SCOPES.read,
            description: 'Read your Accounts, Projects and Databases',
            endpoints: ['GET /v1/*'],
        },
        {
            name: API_KEY_SCOPES.write,
            description: 'Everything your user may do: create, change and delete',
            endpoints: ['GET /v1/*', 'POST /v1/*', 'DELETE /v1/*'],
        },
    ],
};

/** An e-mail madAuth asks us to send: `email.send_*` with its data. */
export interface MailRequest {
    readonly type: string;
    readonly to: string;
    readonly data: Readonly<Record<string, unknown>>;
}

export type SendMail = (mail: MailRequest) => Promise<Result<void, string>>;

/** Calls older or newer than this are refused (Standard Webhooks). */
const TOLERANCE_SECONDS = 5 * 60;

/**
 * Standard Webhooks: `webhook-signature` holds `v1,<base64 HMAC-SHA256 of
 * "<id>.<timestamp>.<body>">`, keyed with the base64 part of `whsec_…`.
 */
export function verifyWebhook(
    secret: string,
    headers: { id: string | undefined; timestamp: string | undefined; signature: string | undefined },
    body: string,
    nowSeconds: number,
): boolean {
    const { id, timestamp, signature } = headers;
    if (id === undefined || timestamp === undefined || signature === undefined || !secret.startsWith('whsec_')) {
        return false;
    }
    const sentAt = Number(timestamp);
    if (!Number.isInteger(sentAt) || Math.abs(nowSeconds - sentAt) > TOLERANCE_SECONDS) {
        return false;
    }
    const expected = createHmac('sha256', Buffer.from(secret.slice('whsec_'.length), 'base64'))
        .update(`${id}.${timestamp}.${body}`)
        .digest();
    // Several signatures may be sent, space separated, during a secret rotation.
    return signature.split(' ').some((candidate) => {
        const [version, value] = candidate.split(',');
        const given = Buffer.from(value ?? '', 'base64');
        return version === 'v1' && given.length === expected.length && timingSafeEqual(given, expected);
    });
}

export interface SidecarDeps {
    readonly webhookSecret: string;
    /** undefined: no mail sender configured; e-mails are refused. */
    readonly sendMail: SendMail | undefined;
    readonly log: (entry: Record<string, unknown>) => void;
    readonly nowSeconds?: () => number;
}

export function createSidecar(deps: SidecarDeps): Hono {
    const app = new Hono();
    const nowSeconds = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

    app.get('/api-key-scopes', (c) => c.json(apiKeyScopes));

    app.post('/webhooks', async (c) => {
        const body = await c.req.text();
        const signed = verifyWebhook(
            deps.webhookSecret,
            {
                id: c.req.header('webhook-id'),
                timestamp: c.req.header('webhook-timestamp'),
                signature: c.req.header('webhook-signature'),
            },
            body,
            nowSeconds(),
        );
        if (!signed) {
            deps.log({ msg: 'madauth webhook: bad signature' });
            return c.body(null, 401);
        }
        const call = JSON.parse(body) as { type?: unknown; data?: Record<string, unknown> };
        const type = typeof call.type === 'string' ? call.type : '';
        const data = call.data ?? {};
        if (!type.startsWith('email.send_')) {
            // Events (user.*) and anything newer: acknowledged, nothing to do yet.
            return c.body(null, 204);
        }
        if (deps.sendMail === undefined || typeof data['to'] !== 'string') {
            deps.log({ msg: 'madauth webhook: no mail sender, e-mail refused', type });
            return c.json({ error: 'e-mail is not configured' }, 503);
        }
        const sent = await deps.sendMail({ type, to: data['to'], data });
        if (!sent.ok) {
            deps.log({ msg: 'madauth webhook: e-mail not sent', type, error: sent.error });
            return c.json({ error: 'e-mail not sent' }, 503);
        }
        return c.body(null, 200);
    });

    return app;
}

/**
 * For the dev cluster only (MAIL=log): the e-mail, its link and its code go
 * to the log instead of a mailbox.
 */
export const logMail =
    (log: (entry: Record<string, unknown>) => void): SendMail =>
    async (mail) => {
        log({ msg: 'e-mail (not sent: MAIL=log)', type: mail.type, to: mail.to, link: mail.data['link'], code: mail.data['code'] });
        return { ok: true, value: undefined };
    };
