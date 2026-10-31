/**
 * The token for the next API call: `OUP_API_KEY` if set (CI), else the
 * access token from `oup login`, refreshed when it has less than a minute
 * left. The new refresh token is stored before the access token is used:
 * madAuth ends the whole chain when an old one is used again. For the same
 * reason two `oup` processes never refresh at once: the second waits for a
 * lock file and then finds the tokens the first one stored.
 */
import { open, rm, stat } from 'node:fs/promises';
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
/** A lock older than this was left by a process that died; a refresh takes seconds. */
const STALE_LOCK_MS = 30_000;
const LOCK_WAIT_MS = 200;

/** Runs `work` while holding `<path>.lock`, created exclusively; waits for another holder. */
async function withLock<T>(path: string, work: () => Promise<T>, now: () => number, sleep: (ms: number) => Promise<void>): Promise<T> {
    const lock = `${path}.lock`;
    const acquire = async (): Promise<void> => {
        const handle = await open(lock, 'wx', 0o600).catch((error: NodeJS.ErrnoException) =>
            error.code === 'EEXIST' ? undefined : Promise.reject(error),
        );
        if (handle !== undefined) {
            return handle.close();
        }
        const held = await stat(lock).then((info) => info.mtimeMs, () => undefined);
        if (held !== undefined && now() - held > STALE_LOCK_MS) {
            await rm(lock, { force: true });
        } else {
            await sleep(LOCK_WAIT_MS);
        }
        return acquire();
    };
    await acquire();
    return work().finally(() => rm(lock, { force: true }));
}

export async function apiAccess(path: string, env: Env = process.env, deps: OidcDeps = {}): Promise<Result<ApiAccess, string>> {
    const apiKey = env['OUP_API_KEY'];
    if (apiKey !== undefined && apiKey !== '') {
        return ok({ apiUrl: env['OUP_API_URL'] || DEFAULT_API_URL, token: apiKey });
    }
    const credentials = await readCredentials(path);
    if (credentials === undefined) {
        return err('not signed in: run oup login (or set OUP_API_KEY)');
    }
    const now = deps.now ?? Date.now;
    const fresh = (stored: Credentials) => stored.accessTokenExpiresAt - MARGIN_MS > now();
    if (fresh(credentials)) {
        return ok({ apiUrl: credentials.apiUrl, token: credentials.accessToken });
    }
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    return withLock(path, () => renew(path, deps), Date.now, sleep);
}

/** Under the lock: another process may have refreshed meanwhile, so read again first. */
async function renew(path: string, deps: OidcDeps): Promise<Result<ApiAccess, string>> {
    const credentials = await readCredentials(path);
    if (credentials === undefined) {
        return err('not signed in: run oup login (or set OUP_API_KEY)');
    }
    if (credentials.accessTokenExpiresAt - MARGIN_MS > (deps.now ?? Date.now)()) {
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
