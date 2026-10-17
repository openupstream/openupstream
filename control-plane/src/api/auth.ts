/**
 * Who calls the public API (ARCHITECTURE.md, decision 59): a madAuth user,
 * with either
 *
 * - their session token, a JWT (ES256, `typ: madauth-session+jwt`, no
 *   audience) verified locally against madAuth's JWKS; a session may do
 *   everything the user may, or
 * - one of their API keys (`madauth_…`, opaque), which madAuth checks for us
 *   (`POST /auth/api-keys/verify`); a key may only do what its scopes allow.
 *
 * The user is a madAuth identity (`usr_…`), which can be a Member of several
 * Accounts.
 */
import { createHash } from 'node:crypto';
import { type JWTVerifyGetKey, createLocalJWKSet, createRemoteJWKSet, jwtVerify } from 'jose';
import type pg from 'pg';
import { type Result, err, ok } from '../result.js';

export interface Identity {
    /** madAuth's user id, e.g. `usr_…`. */
    readonly subject: string;
    readonly email: string | undefined;
    /** An API key's scopes; undefined for a session, which may do everything. */
    readonly scopes: readonly string[] | undefined;
}

export type AuthError =
    /** The token is not one we accept: 401. */
    | { readonly kind: 'invalid'; readonly reason: string }
    /** madAuth or its keys could not be reached: 503, so clients retry. */
    | { readonly kind: 'unavailable'; readonly reason: string };

export type Authenticate = (token: string) => Promise<Result<Identity, AuthError>>;

export const SESSION_TOKEN_TYPE = 'madauth-session+jwt';
export const API_KEY_PREFIX = 'madauth_';

/** jose's errors about fetching the JWKS, as opposed to about the token. */
const UNAVAILABLE = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JOSE_GENERIC']);

const sessionError = (error: unknown): AuthError => {
    const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
    const reason = error instanceof Error ? error.message : String(error);
    // Not a jose error at all (fetch failed) or one about the JWKS itself.
    return code === undefined || UNAVAILABLE.has(code) ? { kind: 'unavailable', reason } : { kind: 'invalid', reason };
};

export function sessionVerifier(config: { readonly issuer: string; readonly keys: JWTVerifyGetKey }): Authenticate {
    return (token) =>
        jwtVerify(token, config.keys, { issuer: config.issuer, algorithms: ['ES256'], typ: SESSION_TOKEN_TYPE }).then(
            ({ payload }) =>
                typeof payload.sub === 'string' && payload.sub !== ''
                    ? ok({
                          subject: payload.sub,
                          email: typeof payload['email'] === 'string' ? payload['email'] : undefined,
                          scopes: undefined,
                      })
                    : err({ kind: 'invalid', reason: 'token has no subject' } as const),
            (error: unknown) => err(sessionError(error)),
        );
}

/**
 * madAuth's JWKS from its in-cluster address, or, for tests and the dev
 * cluster before madAuth runs, a JWKS document inline.
 */
export const keysFrom = (source: { readonly jwksUrl?: string; readonly jwks?: string }): JWTVerifyGetKey =>
    source.jwksUrl !== undefined
        ? createRemoteJWKSet(new URL(source.jwksUrl))
        : createLocalJWKSet(JSON.parse(source.jwks ?? '{}'));

interface VerifiedKey {
    readonly user?: { readonly id?: unknown; readonly email?: unknown };
    readonly apiKey?: { readonly scopes?: unknown };
}

/** How long an answer from madAuth is reused, like madAuth's own verifier. */
export const API_KEY_CACHE_MS = 60_000;
const CACHE_LIMIT = 10_000;

/**
 * Asks madAuth (`madauthUrl`, its in-cluster address) whom an API key acts
 * for and which scopes count now; answers are reused for a minute, keyed by
 * the key's hash. A revoked key therefore works for at most a minute more.
 */
export function apiKeyVerifier(
    madauthUrl: string,
    { fetch: fetcher = fetch, now = Date.now }: { fetch?: typeof fetch; now?: () => number } = {},
): Authenticate {
    const cache = new Map<string, { identity: Identity; until: number }>();
    return async (key) => {
        const hash = createHash('sha256').update(key).digest('hex');
        const cached = cache.get(hash);
        if (cached !== undefined && cached.until > now()) {
            return ok(cached.identity);
        }
        const response = await fetcher(new URL('/auth/api-keys/verify', madauthUrl), {
            method: 'POST',
            headers: { authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(5_000),
        }).then(
            (value) => ok(value),
            (error: unknown) => err({ kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) } as const),
        );
        if (!response.ok) {
            return response;
        }
        if (response.value.status === 401) {
            cache.delete(hash);
            return err({ kind: 'invalid', reason: 'madAuth does not know this API key' });
        }
        const body = (await response.value.json().catch(() => undefined)) as VerifiedKey | undefined;
        const subject = body?.user?.id;
        const scopes = body?.apiKey?.scopes;
        if (response.value.status !== 200 || typeof subject !== 'string' || !Array.isArray(scopes)) {
            return err({ kind: 'unavailable', reason: `madAuth answered ${response.value.status}` });
        }
        const identity: Identity = {
            subject,
            email: typeof body?.user?.email === 'string' ? body.user.email : undefined,
            scopes: scopes.filter((scope): scope is string => typeof scope === 'string'),
        };
        if (cache.size >= CACHE_LIMIT) {
            cache.clear();
        }
        cache.set(hash, { identity, until: now() + API_KEY_CACHE_MS });
        return ok(identity);
    };
}

/** API keys go to madAuth, everything else is taken for a session token. */
export const madauthAuthenticator =
    (sessions: Authenticate, apiKeys: Authenticate): Authenticate =>
    (token) =>
        token.startsWith(API_KEY_PREFIX) ? apiKeys(token) : sessions(token);

/** The Accounts the madAuth user is a Member of. */
export async function accountsOf(pool: pg.Pool, subject: string): Promise<string[]> {
    const { rows } = await pool.query<{ account_id: string }>(
        'select account_id from members where auth_subject = $1 order by account_id',
        [subject],
    );
    return rows.map((row) => row.account_id);
}
