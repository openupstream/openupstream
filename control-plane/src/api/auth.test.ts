import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_KEY_CACHE_MS, apiKeyVerifier } from './auth.js';

const MADAUTH = 'http://madauth.test:8787';
const KEY = 'madauth_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';

/** A fake madAuth: answers `reply` and records what it was sent. */
const fakeMadauth = (reply: () => Response | Promise<Response>) => {
    const calls: { url: string; method: string | undefined; authorization: string | null }[] = [];
    const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
        calls.push({
            url: String(input),
            method: init?.method,
            authorization: new Headers(init?.headers).get('authorization'),
        });
        return reply();
    }) as typeof fetch;
    return { calls, fetcher };
};

const verified = (scopes: string[]) =>
    Response.json({ user: { id: 'usr_abc', email: 'a@b.test', name: 'A' }, apiKey: { id: 'key_1', name: 'ci', scopes } });

test('a key madAuth knows acts for its user with the scopes that count now', async () => {
    const { calls, fetcher } = fakeMadauth(() => verified(['openupstream:read']));
    const result = await apiKeyVerifier(MADAUTH, { fetch: fetcher })(KEY);
    assert.deepEqual(result, { ok: true, value: { subject: 'usr_abc', email: 'a@b.test', scopes: ['openupstream:read'] } });
    assert.deepEqual(calls, [{ url: `${MADAUTH}/auth/api-keys/verify`, method: 'POST', authorization: `Bearer ${KEY}` }]);
});

test('the answer is reused for a minute, then asked again', async () => {
    let now = 1_000_000;
    const { calls, fetcher } = fakeMadauth(() => verified(['openupstream:write']));
    const verify = apiKeyVerifier(MADAUTH, { fetch: fetcher, now: () => now });
    await verify(KEY);
    now += API_KEY_CACHE_MS - 1;
    await verify(KEY);
    assert.equal(calls.length, 1);
    now += 2;
    await verify(KEY);
    assert.equal(calls.length, 2);
});

test('a key madAuth does not know (or revoked) is invalid', async () => {
    const { fetcher } = fakeMadauth(() => Response.json({ error: 'invalid_api_key' }, { status: 401 }));
    assert.deepEqual(await apiKeyVerifier(MADAUTH, { fetch: fetcher })(KEY), {
        ok: false,
        error: { kind: 'invalid', reason: 'madAuth does not know this API key' },
    });
});

test('madAuth unreachable, failing or answering nonsense: unavailable, never valid', async () => {
    const down = fakeMadauth(() => Promise.reject(new TypeError('fetch failed')));
    const failing = fakeMadauth(() => new Response('oops', { status: 500 }));
    const nonsense = fakeMadauth(() => Response.json({ user: {} }));
    for (const { fetcher } of [down, failing, nonsense]) {
        const result = await apiKeyVerifier(MADAUTH, { fetch: fetcher })(KEY);
        assert.equal(result.ok ? 'ok' : result.error.kind, 'unavailable');
    }
});
