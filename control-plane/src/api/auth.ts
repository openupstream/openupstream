/**
 * Who calls the public API: a madAuth JWT (Member sign-in or API key),
 * verified locally against madAuth's JWKS (ARCHITECTURE.md, decision 59).
 * Its subject is a madAuth identity, which can be a Member of several
 * Accounts.
 */
import { type JWTVerifyGetKey, createLocalJWKSet, createRemoteJWKSet, jwtVerify } from 'jose';
import type pg from 'pg';
import { type Result, err, ok } from '../result.js';

export interface TokenConfig {
    readonly issuer: string;
    readonly audience: string;
    readonly keys: JWTVerifyGetKey;
}

export type VerifyError =
    /** The token is not one we accept: 401. */
    | { readonly kind: 'invalid'; readonly reason: string }
    /** The keys could not be fetched (madAuth unreachable): 503, so clients retry. */
    | { readonly kind: 'unavailable'; readonly reason: string };

export type Verify = (token: string) => Promise<Result<{ readonly subject: string }, VerifyError>>;

/** jose's errors about fetching the JWKS, as opposed to about the token. */
const UNAVAILABLE = new Set(['ERR_JWKS_TIMEOUT', 'ERR_JOSE_GENERIC']);

const verifyError = (error: unknown): VerifyError => {
    const code = error instanceof Error && 'code' in error ? String(error.code) : undefined;
    const reason = error instanceof Error ? error.message : String(error);
    // Not a jose error at all (fetch failed) or one about the JWKS itself.
    return code === undefined || UNAVAILABLE.has(code) ? { kind: 'unavailable', reason } : { kind: 'invalid', reason };
};

/** Asymmetric algorithms only: a shared-secret token could be minted by anyone holding the key. */
const ALGORITHMS = ['RS256', 'ES256', 'EdDSA'];

export function jwtVerifier(config: TokenConfig): Verify {
    return (token) =>
        jwtVerify(token, config.keys, { issuer: config.issuer, audience: config.audience, algorithms: ALGORITHMS }).then(
            ({ payload }) =>
                typeof payload.sub === 'string' && payload.sub !== ''
                    ? ok({ subject: payload.sub })
                    : err({ kind: 'invalid', reason: 'token has no subject' } as const),
            (error: unknown) => err(verifyError(error)),
        );
}

/**
 * madAuth's JWKS endpoint (jose caches and refreshes it) or, for tests and
 * the dev cluster, a JWKS document inline.
 */
export const keysFrom = (source: { readonly jwksUrl?: string; readonly jwks?: string }): JWTVerifyGetKey =>
    source.jwksUrl !== undefined ? createRemoteJWKSet(new URL(source.jwksUrl)) : createLocalJWKSet(JSON.parse(source.jwks ?? '{}'));

/** The Accounts the madAuth subject is a Member of. */
export async function accountsOf(pool: pg.Pool, subject: string): Promise<string[]> {
    const { rows } = await pool.query<{ account_id: string }>(
        'select account_id from members where auth_subject = $1 order by account_id',
        [subject],
    );
    return rows.map((row) => row.account_id);
}
