/**
 * Signing in to madAuth as `oup` (ARCHITECTURE.md, decision 87): the device
 * authorization grant (RFC 8628) and refresh tokens. The user approves the
 * code in a browser, on this machine or another one, with any sign-in method
 * they have.
 */
import { parseJson } from './json.js';
import { type Result, err, ok } from './result.js';

export interface Discovery {
    readonly tokenEndpoint: string;
    readonly deviceAuthorizationEndpoint: string;
    readonly endSessionEndpoint: string | undefined;
}

export interface DeviceCode {
    readonly deviceCode: string;
    readonly userCode: string;
    readonly verificationUri: string;
    readonly verificationUriComplete: string;
    readonly expiresIn: number;
    readonly interval: number;
}

export interface TokenSet {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly idToken: string | undefined;
    /** Milliseconds since the epoch. */
    readonly expiresAt: number;
}

/** A refresh token is only issued with `offline_access` (madAuth 0.7). */
export const SCOPE = 'openid email offline_access';
export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
/** RFC 8628: after `slow_down`, wait this much longer between polls. */
const SLOW_DOWN_SECONDS = 5;

export interface OidcDeps {
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const string = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** POSTs a form and answers its JSON with the status; err when the server was not reached. */
const postForm = async (
    fetcher: typeof fetch,
    url: string,
    form: Record<string, string>,
): Promise<Result<{ status: number; body: Record<string, unknown> }, string>> =>
    fetcher(url, { method: 'POST', body: new URLSearchParams(form), signal: AbortSignal.timeout(15_000) }).then(
        async (response) => ok({ status: response.status, body: ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown> }),
        (error: unknown) => err(messageOf(error)),
    );

export async function discover(issuer: string, { fetch: fetcher = fetch }: OidcDeps = {}): Promise<Result<Discovery, string>> {
    const url = new URL('/.well-known/openid-configuration', issuer).href;
    const response = await fetcher(url, { signal: AbortSignal.timeout(15_000) }).then(
        (value) => ok(value),
        (error: unknown) => err(messageOf(error)),
    );
    if (!response.ok) {
        return response;
    }
    const body = (await response.value.json().catch(() => ({}))) as Record<string, unknown>;
    const tokenEndpoint = string(body['token_endpoint']);
    const deviceAuthorizationEndpoint = string(body['device_authorization_endpoint']);
    return tokenEndpoint === undefined || deviceAuthorizationEndpoint === undefined
        ? err(`${url} names no token or device authorization endpoint`)
        : ok({ tokenEndpoint, deviceAuthorizationEndpoint, endSessionEndpoint: string(body['end_session_endpoint']) });
}

export async function startDeviceSignIn(
    discovery: Discovery,
    clientId: string,
    { fetch: fetcher = fetch }: OidcDeps = {},
): Promise<Result<DeviceCode, string>> {
    const response = await postForm(fetcher, discovery.deviceAuthorizationEndpoint, { client_id: clientId, scope: SCOPE });
    if (!response.ok) {
        return response;
    }
    const { status, body } = response.value;
    const deviceCode = string(body['device_code']);
    const userCode = string(body['user_code']);
    const verificationUri = string(body['verification_uri']);
    if (status !== 200 || deviceCode === undefined || userCode === undefined || verificationUri === undefined) {
        return err(`madAuth refused the sign-in: ${string(body['error_description']) ?? string(body['error']) ?? status}`);
    }
    return ok({
        deviceCode,
        userCode,
        verificationUri,
        verificationUriComplete: string(body['verification_uri_complete']) ?? verificationUri,
        expiresIn: typeof body['expires_in'] === 'number' ? body['expires_in'] : 600,
        interval: typeof body['interval'] === 'number' ? body['interval'] : 5,
    });
}

const tokenSetOf = (body: Record<string, unknown>, now: number): TokenSet | undefined => {
    const accessToken = string(body['access_token']);
    const refreshToken = string(body['refresh_token']);
    const expiresIn = typeof body['expires_in'] === 'number' ? body['expires_in'] : 900;
    return accessToken === undefined || refreshToken === undefined
        ? undefined
        : { accessToken, refreshToken, idToken: string(body['id_token']), expiresAt: now + expiresIn * 1000 };
};

/**
 * Polls the token endpoint every `interval` seconds until the user approved
 * or denied the code, or it expired; `slow_down` adds five seconds.
 */
export async function waitForApproval(
    discovery: Discovery,
    clientId: string,
    device: DeviceCode,
    { fetch: fetcher = fetch, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }: OidcDeps = {},
): Promise<Result<TokenSet, string>> {
    const deadline = now() + device.expiresIn * 1000;
    const poll = async (interval: number): Promise<Result<TokenSet, string>> => {
        if (now() >= deadline) {
            return err('the code expired; run oup login again');
        }
        await sleep(interval * 1000);
        const response = await postForm(fetcher, discovery.tokenEndpoint, {
            grant_type: DEVICE_CODE_GRANT,
            device_code: device.deviceCode,
            client_id: clientId,
        });
        if (!response.ok) {
            // Unreachable for a moment: keep polling until the code expires.
            return poll(interval);
        }
        const { status, body } = response.value;
        if (status === 200) {
            const tokens = tokenSetOf(body, now());
            return tokens === undefined ? err('madAuth answered no access or refresh token') : ok(tokens);
        }
        switch (body['error']) {
            case 'authorization_pending':
                return poll(interval);
            case 'slow_down':
                return poll(interval + SLOW_DOWN_SECONDS);
            case 'expired_token':
                return err('the code expired; run oup login again');
            case 'access_denied':
                return err('the sign-in was denied');
            default:
                return err(`madAuth refused the sign-in: ${string(body['error_description']) ?? string(body['error']) ?? status}`);
        }
    };
    return poll(device.interval);
}

export type RefreshError = { readonly kind: 'signed-out' | 'unavailable'; readonly message: string };

/**
 * New tokens for a refresh token, which madAuth then no longer accepts: the
 * caller stores the new refresh token before it uses the access token.
 */
export async function refresh(
    discovery: Discovery,
    clientId: string,
    refreshToken: string,
    { fetch: fetcher = fetch, now = Date.now }: OidcDeps = {},
): Promise<Result<TokenSet, RefreshError>> {
    const response = await postForm(fetcher, discovery.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
    if (!response.ok) {
        return err({ kind: 'unavailable', message: response.error });
    }
    const { status, body } = response.value;
    if (status === 200) {
        const tokens = tokenSetOf(body, now());
        return tokens === undefined ? err({ kind: 'unavailable', message: 'madAuth answered no access or refresh token' }) : ok(tokens);
    }
    return body['error'] === 'invalid_grant'
        ? err({ kind: 'signed-out', message: 'the sign-in has ended; run oup login again' })
        : err({ kind: 'unavailable', message: `madAuth answered ${status}` });
}

/** The ID token's `email`, for showing who is signed in; the token is not verified for that. */
export const emailOf = (idToken: string | undefined): string | undefined => {
    const payload = idToken?.split('.')[1];
    if (payload === undefined) {
        return undefined;
    }
    const claims = parseJson(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof claims === 'object' && claims !== null && 'email' in claims && typeof claims.email === 'string' ? claims.email : undefined;
};
