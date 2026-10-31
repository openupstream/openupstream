/**
 * The token for the next API call: `OUP_API_KEY` if set (CI), else the
 * access token from `oup login`, refreshed when it has less than a minute
 * left. The new refresh token is stored before the access token is used:
 * madAuth ends the whole chain when an old one is used again.
 */
import { DEFAULT_API_URL } from '@openupstream/sdk';
import { type Credentials, readCredentials, writeCredentials } from './credentials.js';
import { type OidcDeps, discover, refresh } from './oidc.js';
import { type Result, err, ok } from './result.js';

export interface ApiAccess {
    readonly apiUrl: string;
    readonly token: string;
}

type Env = Readonly<Record<string, string | undefined>>;

const MARGIN_MS = 60_000;

export async function apiAccess(path: string, env: Env = process.env, deps: OidcDeps = {}): Promise<Result<ApiAccess, string>> {
    const apiKey = env['OUP_API_KEY'];
    if (apiKey !== undefined && apiKey !== '') {
        return ok({ apiUrl: env['OUP_API_URL'] || DEFAULT_API_URL, token: apiKey });
    }
    const credentials = await readCredentials(path);
    if (credentials === undefined) {
        return err('not signed in: run oup login (or set OUP_API_KEY)');
    }
    const now = (deps.now ?? Date.now)();
    if (credentials.accessTokenExpiresAt - MARGIN_MS > now) {
        return ok({ apiUrl: credentials.apiUrl, token: credentials.accessToken });
    }
    const discovery = await discover(credentials.issuer, deps);
    if (!discovery.ok) {
        return err(`cannot reach madAuth: ${discovery.error}`);
    }
    const tokens = await refresh(discovery.value, credentials.clientId, credentials.refreshToken, deps);
    if (!tokens.ok) {
        return err(tokens.error.message);
    }
    const renewed: Credentials = {
        ...credentials,
        refreshToken: tokens.value.refreshToken,
        accessToken: tokens.value.accessToken,
        accessTokenExpiresAt: tokens.value.expiresAt,
        ...(tokens.value.idToken === undefined ? {} : { idToken: tokens.value.idToken }),
    };
    await writeCredentials(path, renewed);
    return ok({ apiUrl: renewed.apiUrl, token: renewed.accessToken });
}
