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
import { WEBHOOK_TOLERANCE_SECONDS, verifyWebhook } from '@madauth/server/webhook';
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

/** A webhook call's body, `{ type, data }`, or undefined when it is not one. */
const parseCall = (body: string): { type: string; data: Record<string, unknown> } | undefined => {
    const parsed: unknown = (() => {
        try {
            return JSON.parse(body);
        } catch {
            return undefined;
        }
    })();
    if (typeof parsed !== 'object' || parsed === null || !('type' in parsed) || typeof parsed.type !== 'string') {
        return undefined;
    }
    const data = 'data' in parsed && typeof parsed.data === 'object' && parsed.data !== null ? parsed.data : {};
    return { type: parsed.type, data: data as Record<string, unknown> };
};

export interface SidecarDeps {
    readonly webhookSecret: string;
    /** undefined: no mail sender configured; e-mails are refused. */
    readonly sendMail: SendMail | undefined;
    readonly log: (entry: Record<string, unknown>) => void;
    /** Milliseconds, like Date.now. */
    readonly now?: () => number;
}

export function createSidecar(deps: SidecarDeps): Hono {
    const app = new Hono();
    const now = deps.now ?? Date.now;
    /**
     * webhook-ids seen within the tolerance window: a signed call is only
     * valid that long, so remembering it that long refuses every replay.
     */
    const seen = new Map<string, number>();
    const firstTime = (id: string): boolean => {
        const expired = now() - WEBHOOK_TOLERANCE_SECONDS * 2000;
        for (const [key, at] of seen) {
            if (at < expired) {
                seen.delete(key);
            }
        }
        if (seen.has(id)) {
            return false;
        }
        seen.set(id, now());
        return true;
    };

    app.get('/api-key-scopes', (c) => c.json(apiKeyScopes));

    app.post('/webhooks', async (c) => {
        const body = await c.req.text();
        // madAuth's own check (Standard Webhooks), the version of the image it runs.
        if (!verifyWebhook(deps.webhookSecret, c.req.raw.headers, body, { now: now() })) {
            deps.log({ msg: 'madauth webhook: bad signature' });
            return c.body(null, 401);
        }
        if (!firstTime(c.req.header('webhook-id') ?? '')) {
            deps.log({ msg: 'madauth webhook: replayed call refused', id: c.req.header('webhook-id') });
            return c.body(null, 409);
        }
        const call = parseCall(body);
        if (call === undefined) {
            deps.log({ msg: 'madauth webhook: body is not {type, data}' });
            return c.json({ error: 'malformed call' }, 400);
        }
        const { type, data } = call;
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
