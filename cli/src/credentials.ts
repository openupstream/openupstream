/**
 * What `oup login` keeps: the API it signed in to, madAuth's issuer and the
 * CLI's client ID there, and the tokens. One JSON file, readable by its
 * owner only, replaced in one step so a crash never leaves half of it.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseJson } from './json.js';

export interface Credentials {
    readonly apiUrl: string;
    readonly issuer: string;
    readonly clientId: string;
    /** Rotated on every refresh; using an old one ends the whole chain (madAuth). */
    readonly refreshToken: string;
    readonly accessToken: string;
    /** Milliseconds since the epoch. */
    readonly accessTokenExpiresAt: number;
    /** For `oup logout`, which ends the CLI's refresh tokens at madAuth. */
    readonly idToken?: string;
    readonly email?: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/** `$XDG_CONFIG_HOME/openupstream/credentials.json`, by default under `~/.config`. */
export const credentialsPath = (env: Env = process.env): string =>
    join(env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'openupstream', 'credentials.json');

const isCredentials = (value: unknown): value is Credentials =>
    typeof value === 'object' &&
    value !== null &&
    ['apiUrl', 'issuer', 'clientId', 'refreshToken', 'accessToken'].every((key) => typeof (value as Record<string, unknown>)[key] === 'string') &&
    typeof (value as Record<string, unknown>)['accessTokenExpiresAt'] === 'number';

/** The stored credentials; undefined when there are none (or the file is not ours to read). */
export async function readCredentials(path: string): Promise<Credentials | undefined> {
    const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) =>
        error.code === 'ENOENT' ? undefined : Promise.reject(error),
    );
    if (text === undefined) {
        return undefined;
    }
    const parsed = parseJson(text);
    return isCredentials(parsed) ? parsed : undefined;
}

export async function writeCredentials(path: string, credentials: Credentials): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
}

export async function removeCredentials(path: string): Promise<void> {
    await rm(path, { force: true });
}
