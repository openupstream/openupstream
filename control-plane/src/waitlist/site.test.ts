import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../mail.js';
import { type Result, err, ok } from '../result.js';
import { type TestDatabase, createTestDatabase } from '../testing/postgres.js';
import { CONSENT, createWaitlistSite } from './site.js';
import { purgeUnconfirmed } from './store.js';

const URL_BASE = 'https://openupstream.test';

let db: TestDatabase;
let site: ReturnType<typeof createWaitlistSite>;
let sent: { to: string; message: Message }[] = [];
let mailResult: Result<void, string> = ok(undefined);
let logs: Record<string, unknown>[] = [];

before(async () => {
    db = await createTestDatabase();
    site = createWaitlistSite({
        pool: db.pool,
        url: URL_BASE,
        imprint: 'Dora Example\nExample Street 1 & 2\n12345 Berlin',
        sendMail: async (to, message) => {
            sent.push({ to, message });
            return mailResult;
        },
        log: (entry) => logs.push(entry),
    });
});

after(async () => {
    await db.close();
});

beforeEach(async () => {
    sent = [];
    logs = [];
    mailResult = ok(undefined);
    await db.pool.query('delete from waitlist');
});

const post = (path: string, fields: Record<string, string>) =>
    site.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
    });

const join = (email: string) => post('/waitlist', { email, consent: 'yes' });

/** The token in the last e-mail's link to `path`. */
const tokenIn = (path: string): string => {
    const text = sent.at(-1)?.message.text ?? '';
    const token = new RegExp(`${URL_BASE}${path}\\?token=([A-Za-z0-9_-]+)`).exec(text)?.[1];
    assert.ok(token, `no ${path} link in ${text}`);
    return token;
};

const row = async (email: string) =>
    (await db.pool.query<{ consent: string; confirmed_at: Date | null }>('select consent, confirmed_at from waitlist where email = $1', [email])).rows[0];

test('the page says the service is coming, with the form, the consent text, privacy notice and Impressum', async () => {
    const page = await (await site.request('/')).text();
    assert.match(page, /Coming soon/);
    assert.match(page, /<form method="post" action="\/waitlist">/);
    assert.ok(page.includes(CONSENT.text));
    assert.match(page, /href="\/privacy"/);
    assert.match(page, /href="\/imprint"/);
    const imprint = await (await site.request('/imprint')).text();
    assert.ok(imprint.includes('Example Street 1 &amp; 2'), 'the Impressum is escaped');
    assert.match(await (await site.request('/privacy')).text(), /Art\. 6\(1\)\(a\) GDPR/);
});

test('every page is locked down: no scripts, no framing, no referrer, not cached', async () => {
    const response = await site.request('/');
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'.*form-action 'self'.*frame-ancestors 'none'/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await site.request('/nothing-here')).status, 404);
});

test('double opt-in: the form stores a pending address and mails a link; only the confirmation puts it on the list', async () => {
    const response = await join(' Dora@Example.TEST ');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Check your inbox/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.to, 'dora@example.test');
    assert.match(sent[0]?.message.subject ?? '', /Confirm your address/);
    assert.deepEqual(await row('dora@example.test'), { consent: CONSENT.version, confirmed_at: null });

    const token = tokenIn('/waitlist/confirm');
    // Opening the link (or a mail scanner doing so) only shows the button.
    const page = await site.request(`/waitlist/confirm?token=${token}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<button type="submit">Confirm<\/button>/);
    assert.equal((await row('dora@example.test'))?.confirmed_at, null);

    const confirmed = await post('/waitlist/confirm', { token });
    assert.equal(confirmed.status, 200);
    assert.match(await confirmed.text(), /You are on the waitlist/);
    assert.ok((await row('dora@example.test'))?.confirmed_at instanceof Date);
    // Again is fine, and the link now shows the list.
    assert.equal((await post('/waitlist/confirm', { token })).status, 200);
    assert.match(await (await site.request(`/waitlist/confirm?token=${token}`)).text(), /You are on the waitlist/);
});

test('without the consent box or with a bad address nothing is stored or sent', async () => {
    assert.equal((await post('/waitlist', { email: 'dora@example.test' })).status, 400);
    assert.equal((await post('/waitlist', { email: 'not an address', consent: 'yes' })).status, 400);
    assert.equal((await post('/waitlist', { consent: 'yes' })).status, 400);
    assert.equal(sent.length, 0);
    assert.equal((await db.pool.query('select 1 from waitlist')).rowCount, 0);
});

test('the answer is the same whether or not the address is on the list, and an address gets at most one e-mail an hour', async () => {
    const first = await (await join('dora@example.test')).text();
    const again = await join('dora@example.test');
    assert.equal(again.status, 200);
    assert.equal(await again.text(), first);
    assert.equal(sent.length, 1, 'no second e-mail within the hour');

    // An hour later a pending address gets a new confirmation; its old link no longer works.
    const oldToken = tokenIn('/waitlist/confirm');
    await db.pool.query(`update waitlist set mailed_at = now() - interval '61 minutes'`);
    await join('dora@example.test');
    assert.equal(sent.length, 2);
    assert.notEqual(tokenIn('/waitlist/confirm'), oldToken);
    assert.equal((await post('/waitlist/confirm', { token: oldToken })).status, 404);

    // A confirmed address is told it is on the list, with a link to remove it.
    assert.equal((await post('/waitlist/confirm', { token: tokenIn('/waitlist/confirm') })).status, 200);
    await db.pool.query(`update waitlist set mailed_at = now() - interval '61 minutes'`);
    assert.equal(await (await join('dora@example.test')).text(), first);
    assert.match(sent.at(-1)?.message.subject ?? '', /You are on the openupstream waitlist/);
    assert.ok((await row('dora@example.test'))?.confirmed_at instanceof Date, 'still confirmed');
});

test('the removal link deletes the address at once, pending or confirmed', async () => {
    await join('dora@example.test');
    const token = tokenIn('/waitlist/remove');
    assert.match(await (await site.request(`/waitlist/remove?token=${token}`)).text(), /Remove my address/);
    assert.ok(await row('dora@example.test'), 'opening the link removes nothing');
    const removed = await post('/waitlist/remove', { token });
    assert.equal(removed.status, 200);
    assert.equal(await row('dora@example.test'), undefined);
    assert.equal((await post('/waitlist/remove', { token })).status, 404);

    await join('erik@example.test');
    const confirm = tokenIn('/waitlist/confirm');
    await post('/waitlist/confirm', { token: confirm });
    // The page after confirming offers removal with the same token.
    assert.equal((await post('/waitlist/remove', { token: confirm })).status, 200);
    assert.equal(await row('erik@example.test'), undefined);
});

test('an unconfirmed address expires after 48 hours: its link stops working and the cleanup deletes it', async () => {
    await join('dora@example.test');
    await join('erik@example.test');
    const erik = tokenIn('/waitlist/confirm');
    await post('/waitlist/confirm', { token: erik });
    await db.pool.query(`update waitlist set mailed_at = now() - interval '49 hours'`);
    const dora = sent[0]?.message.text.match(/confirm\?token=([A-Za-z0-9_-]+)/)?.[1] ?? '';
    assert.equal((await site.request(`/waitlist/confirm?token=${dora}`)).status, 404);
    assert.equal((await post('/waitlist/confirm', { token: dora })).status, 404);
    assert.equal(await purgeUnconfirmed(db.pool), 1);
    assert.equal(await row('dora@example.test'), undefined);
    assert.ok(await row('erik@example.test'), 'a confirmed address stays');
});

test('when the e-mail cannot be sent, the visitor is told, may try again at once, and the address is not logged', async () => {
    mailResult = err('SES: throttled');
    assert.equal((await join('dora@example.test')).status, 503);
    assert.deepEqual(logs, [{ msg: 'waitlist e-mail not sent', error: 'SES: throttled' }]);
    // Nobody can confirm it, so the next cleanup pass deletes it.
    assert.equal(await purgeUnconfirmed(db.pool), 1);
    mailResult = ok(undefined);
    await join('dora@example.test');
    mailResult = err('SES: throttled');
    await db.pool.query(`update waitlist set mailed_at = now() - interval '61 minutes'`);
    assert.equal((await join('dora@example.test')).status, 503);
    mailResult = ok(undefined);
    assert.equal((await join('dora@example.test')).status, 200);
    assert.equal(sent.length, 4, 'the retry after a failure was not held back by the hour');
});

test('malformed and unknown tokens get the expired-link page', async () => {
    for (const token of ['', 'short', 'x'.repeat(43), '<script>']) {
        assert.equal((await site.request(`/waitlist/confirm?token=${encodeURIComponent(token)}`)).status, 404, token);
        assert.equal((await post('/waitlist/remove', { token })).status, 404, token);
    }
});

test('a body larger than a form is refused', async () => {
    const response = await post('/waitlist', { email: `${'a'.repeat(5000)}@example.test`, consent: 'yes' });
    assert.equal(response.status, 413);
    assert.equal(sent.length, 0);
});
