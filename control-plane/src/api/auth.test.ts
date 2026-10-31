import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { ok } from '../result.js';
import {
    ACCESS_TOKEN_TYPE,
    API_KEY_CACHE_MS,
    SESSION_TOKEN_TYPE,
    accessTokenVerifier,
    apiKeyVerifier,
    madauthAuthenticator,
    sessionVerifier,
} from './auth.js';

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

test('concurrent requests with one new key ask madAuth once', async () => {
    let release: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
        release = resolve;
    });
    const { calls, fetcher } = fakeMadauth(async () => {
        await answered;
        return verified(['openupstream:read']);
    });
    const verify = apiKeyVerifier(MADAUTH, { fetch: fetcher });
    const results = Promise.all([verify(KEY), verify(KEY), verify(KEY)]);
    release();
    assert.ok((await results).every((result) => result.ok));
    assert.equal(calls.length, 1);
});

describe('access tokens from the CLI\'s device sign-in', async () => {
    const ISSUER = 'https://openupstream.test';
    const CLI = 'mc_cli';
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const keys = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: 'ES256' }] });
    const jwt = (typ: string, audience?: string) => {
        const token = new SignJWT({ client_id: audience, scope: 'openid email offline_access' })
            .setProtectedHeader({ alg: 'ES256', typ })
            .setSubject('usr_abc')
            .setIssuer(ISSUER)
            .setIssuedAt()
            .setExpirationTime('15m');
        return (audience === undefined ? token : token.setAudience(audience)).sign(privateKey);
    };
    const authenticate = madauthAuthenticator(
        sessionVerifier({ issuer: ISSUER, keys }),
        async () => ok({ subject: 'usr_key', email: undefined, scopes: [] }),
        accessTokenVerifier({ issuer: ISSUER, keys, clientIds: [CLI] }),
    );

    test("the CLI's access token acts for its user like a session", async () => {
        assert.deepEqual(await authenticate(await jwt(ACCESS_TOKEN_TYPE, CLI)), {
            ok: true,
            value: { subject: 'usr_abc', email: undefined, scopes: undefined },
        });
    });

    test("another application's access token, or one without an audience, is invalid", async () => {
        for (const token of [await jwt(ACCESS_TOKEN_TYPE, 'mc_grafana'), await jwt(ACCESS_TOKEN_TYPE)]) {
            const result = await authenticate(token);
            assert.equal(result.ok ? 'ok' : result.error.kind, 'invalid');
        }
    });

    test('a session stays a session; an ID token passes for neither', async () => {
        assert.equal((await authenticate(await jwt(SESSION_TOKEN_TYPE))).ok, true);
        const idToken = await authenticate(await jwt('JWT', CLI));
        assert.equal(idToken.ok ? 'ok' : idToken.error.kind, 'invalid');
    });

    test('without a CLI client ID no access token is accepted', async () => {
        const none = accessTokenVerifier({ issuer: ISSUER, keys, clientIds: [] });
        const result = await none(await jwt(ACCESS_TOKEN_TYPE, CLI));
        assert.equal(result.ok ? 'ok' : result.error.kind, 'invalid');
    });
});
