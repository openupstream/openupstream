/**
 * The waitlist page at our own hostname (ARCHITECTURE.md, decision 86),
 * while sign-up on the hosted service is closed: it says the service is
 * coming, and takes an e-mail address to tell when it opens. Plain HTML
 * forms, no script, no cookies.
 *
 * Double opt-in: the form stores the address as pending and sends an
 * e-mail; only its confirmation link puts the address on the list. Every
 * e-mail has a link that removes the address at once. A link only shows a
 * page with a button, and the button's POST acts, so a mail scanner that
 * opens links confirms or removes nothing. The page answers alike whether
 * or not an address is on the list already, so it tells nobody who is.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { html } from 'hono/html';
import type { HtmlEscapedString } from 'hono/utils/html';
import type pg from 'pg';
import { z } from 'zod';
import type { Message } from '../mail.js';
import type { Result } from '../result.js';
import {
    CONFIRM_WITHIN,
    confirmEntry,
    entryState,
    hashToken,
    mailFailed,
    newToken,
    removeEntry,
    requestEntry,
} from './store.js';

/** The consent the form asks for; a changed text gets a new version, which is stored with each address. */
export const CONSENT = {
    version: '2026-10-31',
    text: 'Send me an e-mail when the hosted openupstream service opens for sign-up. I can withdraw this at any time with the link in every e-mail.',
} as const;

export interface WaitlistSiteDeps {
    readonly pool: pg.Pool;
    /** The page's public URL, without a trailing slash, e.g. `https://openupstream.com`; e-mail links point here. */
    readonly url: string;
    /** The Impressum (§ 5 DDG): who runs the service and how to reach them, as plain text. */
    readonly imprint: string;
    readonly sendMail: (to: string, message: Message) => Promise<Result<void, string>>;
    readonly log: (entry: Record<string, unknown>) => void;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const emailInput = z.email().max(254);

type Page = HtmlEscapedString | Promise<HtmlEscapedString>;

const layout = (title: string, body: Page): Page => html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root { color-scheme: light dark; --fg: #1d2125; --muted: #5b636b; --bg: #fbfbfa; --accent: #0b5cad; --line: #d9dcdf; }
@media (prefers-color-scheme: dark) { :root { --fg: #e8eaec; --muted: #a3abb3; --bg: #15181b; --accent: #7db4ef; --line: #33393f; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 34rem; margin: 0 auto; padding: 3rem 1rem 2rem; }
h1 { font-size: 1.9rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
h2 { font-size: 1.2rem; margin: 2rem 0 .5rem; }
a { color: var(--accent); }
.muted, footer { color: var(--muted); }
label { display: block; font-weight: 600; margin: 1rem 0 .3rem; }
input[type=email] { box-sizing: border-box; width: 100%; padding: .6rem .7rem; font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 6px; }
.consent { display: flex; gap: .6rem; align-items: flex-start; font-weight: 400; }
.consent input { margin-top: .35rem; }
button { margin-top: 1rem; padding: .6rem 1.1rem; font: inherit; font-weight: 600; color: #fff; background: var(--accent); border: 0; border-radius: 6px; cursor: pointer; }
@media (prefers-color-scheme: dark) { button { color: #0d1114; } }
.error { color: #b3261e; font-weight: 600; }
footer { max-width: 34rem; margin: 0 auto; padding: 1rem 1rem 3rem; font-size: .9rem; border-top: 1px solid var(--line); }
pre { font: inherit; white-space: pre-wrap; }
</style>
</head>
<body>
<main>
${body}
</main>
<footer><a href="/">openupstream</a> · <a href="/privacy">Privacy</a> · <a href="/imprint">Imprint</a> · <a href="https://github.com/openupstream/openupstream">Source code</a></footer>
</body>
</html>
`;

const signupForm = (error?: string, email = ''): Page => html`<h2>Hear when it opens</h2>
<form method="post" action="/waitlist">
${error === undefined ? '' : html`<p class="error">${error}</p>`}
<label for="email">E-mail address</label>
<input id="email" name="email" type="email" required maxlength="254" autocomplete="email" value="${email}">
<label class="consent"><input name="consent" type="checkbox" value="yes" required> <span>${CONSENT.text} See the <a href="/privacy">privacy notice</a>.</span></label>
<button type="submit">Join the waitlist</button>
</form>
<p class="muted">We first send you an e-mail to confirm your address. Until you confirm, nothing is kept for longer than 48 hours.</p>`;

const home = (error?: string, email?: string): Page =>
    layout(
        'openupstream: coming soon',
        html`<h1>openupstream</h1>
<p class="muted">Coming soon</p>
<p>An EU cloud for Postgres, object storage, static sites and containers, run in three data centres in Germany at three providers.</p>
<p>The hosted service at openupstream.com is not open for sign-up yet. The code is open source, and you can <a href="https://github.com/openupstream/openupstream">run it yourself</a> today.</p>
${signupForm(error, email)}`,
    );

const actionForm = (action: string, token: string, label: string): Page => html`<form method="post" action="${action}">
<input type="hidden" name="token" value="${token}">
<button type="submit">${label}</button>
</form>`;

const removeOffer = (token: string): Page => html`<h2>Changed your mind?</h2>
<p>Remove your address from the list, and we will not write to you.</p>
${actionForm('/waitlist/remove', token, 'Remove my address')}`;

const onList = (token: string): Page =>
    layout(
        'On the waitlist: openupstream',
        html`<h1>You are on the waitlist</h1>
<p>We will write to you once, when the hosted service opens for sign-up, and then delete the list.</p>
${removeOffer(token)}`,
    );

const linkGone = (): Page =>
    layout(
        'Link expired: openupstream',
        html`<h1>This link no longer works</h1>
<p>A confirmation link works for 48 hours, and every new e-mail replaces the links of the one before. If your address was removed, it is gone already.</p>
<p><a href="/">Join the waitlist again</a></p>`,
    );

/** The two e-mails: confirm a new address; or, for one on the list already, how to remove it. */
export const confirmationMail = (url: string, token: string): Message => ({
    subject: 'Confirm your address for the openupstream waitlist',
    text: `Someone, hopefully you, asked to be told by e-mail when the hosted openupstream service opens for sign-up.

Confirm your address within 48 hours with this link:
${url}/waitlist/confirm?token=${token}

If you do not confirm it, we delete your address after 48 hours and do not write again. To remove it now:
${url}/waitlist/remove?token=${token}

openupstream
${url}/imprint`,
});

export const alreadyOnListMail = (url: string, token: string): Message => ({
    subject: 'You are on the openupstream waitlist',
    text: `Someone, hopefully you, asked to join the openupstream waitlist with this address, which is on it already. We will write to you once, when the hosted service opens for sign-up.

To remove your address from the list:
${url}/waitlist/remove?token=${token}

openupstream
${url}/imprint`,
});

const privacy = (url: string): Page =>
    layout(
        'Privacy: openupstream',
        html`<h1>Privacy notice</h1>
<p>This notice covers this page and the waitlist. The hosted service itself is not open yet.</p>
<h2>Who is responsible</h2>
<p>The person named in the <a href="/imprint">imprint</a> is the controller under the GDPR. Write to the address given there for anything below.</p>
<h2>What we store, and why</h2>
<p>When you join the waitlist we store your e-mail address, when you asked, when you confirmed, and which consent text you agreed to. We use the address for one purpose: to tell you when the hosted service opens for sign-up. The legal basis is your consent (Art. 6(1)(a) GDPR); the timestamps are our record of it.</p>
<p>We send you an e-mail to confirm your address first. If you do not confirm within ${CONFIRM_WITHIN}, we delete it. Once we have sent the e-mail that sign-up is open, we delete the list.</p>
<h2>Withdrawing your consent</h2>
<p>Every e-mail from the waitlist has a link that deletes your address at once. You can also write to us. Withdrawing does not affect what happened before.</p>
<h2>Who else processes it</h2>
<ul>
<li>The list is stored in our database on rented servers in Germany (Hetzner and OVHcloud), with backups at Hetzner in Nuremberg.</li>
<li>The e-mails are sent through Amazon Simple Email Service in its Frankfurt region, by Amazon Web Services EMEA SARL, Luxembourg, as our processor. Amazon is a US group, so a transfer to the US cannot be ruled out; it is covered by the EU–US Data Privacy Framework and the EU standard contractual clauses in AWS's data processing addendum.</li>
</ul>
<h2>Visiting this page</h2>
<p>This page sets no cookies and loads nothing from anyone else. To deliver it and protect it from abuse, our servers process your IP address, and the request is written to our server logs (Art. 6(1)(f) GDPR).</p>
<h2>Your rights</h2>
<p>You have the right to access, rectification, erasure, restriction of processing and data portability, and to object to processing based on legitimate interests. You may also complain to a data protection supervisory authority.</p>
<p class="muted">${url}/privacy, version ${CONSENT.version}</p>`,
    );

const imprint = (text: string): Page =>
    layout(
        'Imprint: openupstream',
        html`<h1>Imprint</h1>
<p class="muted">Impressum, § 5 DDG</p>
<pre>${text}</pre>`,
    );

const notFound = (): Page => layout('Not found: openupstream', html`<h1>Not found</h1><p><a href="/">To the front page</a></p>`);

const tokenOf = (value: unknown): string | undefined => (typeof value === 'string' && TOKEN.test(value) ? value : undefined);

export function createWaitlistSite(deps: WaitlistSiteDeps): Hono {
    const { pool, url } = deps;
    const app = new Hono();

    app.use(async (c, next) => {
        await next();
        c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
        c.header('Referrer-Policy', 'no-referrer');
        c.header('X-Content-Type-Options', 'nosniff');
        // The confirm and remove pages carry a token in their URL and form.
        c.header('Cache-Control', 'no-store');
    });
    // A form with an address and a checkbox is far below this.
    app.use(bodyLimit({ maxSize: 4096, onError: (c) => c.html(home('That was too much to read. Try again.'), 413) }));

    app.get('/', (c) => c.html(home()));
    app.get('/privacy', (c) => c.html(privacy(url)));
    app.get('/imprint', (c) => c.html(imprint(deps.imprint)));

    app.post('/waitlist', async (c) => {
        const form = await c.req.parseBody();
        const typed = typeof form['email'] === 'string' ? form['email'].trim().toLowerCase() : '';
        const email = emailInput.safeParse(typed);
        if (!email.success) {
            return c.html(home('Please enter a valid e-mail address.', typed.slice(0, 254)), 400);
        }
        if (form['consent'] !== 'yes') {
            return c.html(home('Please tick the box, so we may write to you.', email.data), 400);
        }
        const { token, hash } = newToken();
        const mail = await requestEntry(pool, email.data, hash, CONSENT.version);
        if (mail !== undefined) {
            const sent = await deps.sendMail(email.data, mail === 'confirm' ? confirmationMail(url, token) : alreadyOnListMail(url, token));
            if (!sent.ok) {
                await mailFailed(pool, hash);
                // Not the address: the log needs the fact, not who.
                deps.log({ msg: 'waitlist e-mail not sent', error: sent.error });
                return c.html(home('We could not send you an e-mail just now. Please try again later.', email.data), 503);
            }
        }
        return c.html(
            layout(
                'Check your inbox: openupstream',
                html`<h1>Check your inbox</h1>
<p>We have sent an e-mail to ${email.data}. Open the link in it within 48 hours to confirm your address.</p>
<p class="muted">No e-mail? Look in your spam folder. You can ask for another one after an hour.</p>`,
            ),
        );
    });

    app.get('/waitlist/confirm', async (c) => {
        const token = tokenOf(c.req.query('token'));
        const state = token === undefined ? undefined : await entryState(pool, hashToken(token));
        if (token === undefined || state === undefined) {
            return c.html(linkGone(), 404);
        }
        if (state === 'confirmed') {
            return c.html(onList(token));
        }
        return c.html(
            layout(
                'Confirm your address: openupstream',
                html`<h1>Confirm your address</h1>
<p>${CONSENT.text}</p>
${actionForm('/waitlist/confirm', token, 'Confirm')}`,
            ),
        );
    });

    app.post('/waitlist/confirm', async (c) => {
        const token = tokenOf((await c.req.parseBody())['token']);
        if (token === undefined || !(await confirmEntry(pool, hashToken(token)))) {
            return c.html(linkGone(), 404);
        }
        return c.html(onList(token));
    });

    app.get('/waitlist/remove', async (c) => {
        const token = tokenOf(c.req.query('token'));
        if (token === undefined || (await entryState(pool, hashToken(token))) === undefined) {
            return c.html(linkGone(), 404);
        }
        return c.html(
            layout(
                'Remove your address: openupstream',
                html`<h1>Remove your address?</h1>
<p>We delete it from the waitlist at once and will not write to you.</p>
${actionForm('/waitlist/remove', token, 'Remove my address')}`,
            ),
        );
    });

    app.post('/waitlist/remove', async (c) => {
        const token = tokenOf((await c.req.parseBody())['token']);
        if (token === undefined || !(await removeEntry(pool, hashToken(token)))) {
            return c.html(linkGone(), 404);
        }
        return c.html(
            layout(
                'Removed: openupstream',
                html`<h1>Your address is removed</h1>
<p>It is deleted from the waitlist, and we will not write to you.</p>
<p><a href="/">To the front page</a></p>`,
            ),
        );
    });

    app.notFound((c) => c.html(notFound(), 404));

    return app;
}
