/**
 * `oup pg proxy`: a Database reached from this machine (ARCHITECTURE.md,
 * decision 126; ADR-0005). Every local connection gets a WebSocket of its
 * own to the Project's tunnel, opened with a fresh token, and the client
 * logs in with the caller's own Postgres role.
 *
 * Before anything listens on the local port, a first login through the
 * tunnel waits for the role (the operator adds it within a pass) and, at
 * `owner`, sets `app` as the role's default role, so that what a migration
 * creates belongs to `app`.
 */
import { once } from 'node:events';
import { type AddressInfo, type Server, createServer } from 'node:net';
import { pipeline } from 'node:stream';
import { DATABASE_ACCESS_LEVELS, type DatabaseAccess, type DatabaseProxy } from '@openupstream/sdk';
import pg from 'pg';
import { WebSocket, createWebSocketStream } from 'ws';
import { type Result, err, ok } from './result.js';

/** Where the proxy listens: an IPv4 address, so `localhost` resolving to ::1 never reaches another server. */
export const LISTEN_HOST = '127.0.0.1';
export const DEFAULT_PORT = 5432;
/** How long the first login waits for the role and the tunnel's forwarder, which start within an operator pass or two. */
export const ROLE_WAIT_MS = 4 * 60_000;
const RETRY_MS = 3_000;
/** Pings keep a quiet tunnel (an idle psql) open through Traefik. */
export const PING_INTERVAL_MS = 30_000;

export const parseAccess = (value: string | undefined): Result<DatabaseAccess, string> =>
    value === undefined
        ? ok('read')
        : (DATABASE_ACCESS_LEVELS as readonly string[]).includes(value)
          ? ok(value as DatabaseAccess)
          : err(`--access is one of ${DATABASE_ACCESS_LEVELS.join(', ')}`);

export const parsePort = (value: string | undefined): Result<number, string> => {
    const port = value === undefined ? DEFAULT_PORT : Number(value);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? ok(port) : err(`--port must be a port number, not ${value}`);
};

/** The URL a Postgres client connects with while the proxy runs. The password is URL-safe as generated. */
export const connectionUrl = (proxy: Pick<DatabaseProxy, 'user' | 'password' | 'database'>, port: number): string =>
    `postgres://${proxy.user}:${proxy.password}@${LISTEN_HOST}:${port}/${proxy.database}?sslmode=disable`;

export type TunnelError =
    /** The platform said no (401, 403, 404): retrying changes nothing. */
    | { readonly kind: 'refused'; readonly status: number }
    /** Not reachable now (no forwarder yet, a restart, the network): worth another try. */
    | { readonly kind: 'unavailable'; readonly message: string };

export const tunnelErrorMessage = (error: TunnelError): string =>
    error.kind === 'unavailable'
        ? `the tunnel is not reachable: ${error.message}`
        : error.status === 401
          ? 'the tunnel refused your sign-in (401): run oup login again'
          : error.status === 403
            ? 'the tunnel refused you (403): an API key needs openupstream:write'
            : `the tunnel refused you (${error.status})`;

/** Opens one WebSocket to the tunnel with `token`. */
export function openTunnel(url: string, token: string): Promise<Result<WebSocket, TunnelError>> {
    return new Promise((resolve) => {
        const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, perMessageDeflate: false, handshakeTimeout: 15_000 });
        ws.once('open', () => resolve(ok(ws)));
        ws.once('unexpected-response', (_request, response) => {
            const status = response.statusCode ?? 0;
            ws.terminate();
            resolve(err(status === 401 || status === 403 || status === 404 ? { kind: 'refused', status } : { kind: 'unavailable', message: `HTTP ${status}` }));
        });
        ws.once('error', (error) => resolve(err({ kind: 'unavailable', message: error.message })));
    });
}

export interface TunnelDeps {
    readonly url: string;
    /** A token for the next tunnel: an access token of `oup` lasts 15 minutes, so each tunnel asks anew. */
    readonly token: () => Promise<Result<string, string>>;
    readonly warn: (message: string) => void;
    readonly pingIntervalMs?: number;
}

/** Carries every connection `server` accepts through a tunnel of its own. */
export function serveTunnel(server: Server, deps: TunnelDeps): void {
    server.on('connection', async (socket) => {
        socket.setNoDelay(true);
        socket.pause();
        const token = await deps.token();
        const tunnel = token.ok ? await openTunnel(deps.url, token.value) : err({ kind: 'unavailable', message: token.error } as const);
        if (!tunnel.ok) {
            deps.warn(`a connection could not be carried: ${tunnelErrorMessage(tunnel.error)}`);
            socket.destroy();
            return;
        }
        const ws = tunnel.value;
        const ping = setInterval(() => ws.ping(), deps.pingIntervalMs ?? PING_INTERVAL_MS);
        const stream = createWebSocketStream(ws);
        pipeline(socket, stream, socket, () => {
            clearInterval(ping);
            ws.terminate();
            socket.destroy();
        });
        socket.resume();
    });
}

/**
 * Listens on `port` of LISTEN_HOST; an error when it is taken. Only the
 * outcome of listening is handled here: neither listener stays behind.
 */
export function listen(server: Server, port: number): Promise<Result<number, string>> {
    return new Promise((resolve) => {
        const failed = (error: NodeJS.ErrnoException) => {
            server.off('listening', listening);
            resolve(err(error.code === 'EADDRINUSE' ? `port ${port} is taken (a Postgres of your own?); choose another with --port` : error.message));
        };
        const listening = () => {
            server.off('error', failed);
            resolve(ok((server.address() as AddressInfo).port));
        };
        server.once('error', failed);
        server.once('listening', listening);
        server.listen(port, LISTEN_HOST);
    });
}

/** Whether `port` is free now: listened on and let go at once, so a taken port is reported before any waiting. */
export async function portFree(port: number): Promise<Result<void, string>> {
    const probe = createServer();
    const listened = await listen(probe, port);
    if (!listened.ok) {
        return listened;
    }
    probe.close();
    await once(probe, 'close');
    return ok(undefined);
}

export interface PrepareDeps extends TunnelDeps {
    readonly proxy: DatabaseProxy;
    readonly report: (message: string) => void;
    readonly waitMs?: number;
    readonly retryMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The SQLSTATE of a Postgres error, if it is one. */
const sqlState = (error: unknown): string | undefined =>
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;

/**
 * Logs in as the role through the tunnel until it works, then, at `owner`,
 * makes `app` the role's default role and checks that a new login acts as
 * `app`. Through a listener of its own on a free port, closed afterwards.
 * A refused tunnel ends the wait at once; a role or forwarder not there yet
 * is waited for, up to `waitMs`.
 */
export async function prepareRole(deps: PrepareDeps): Promise<Result<void, string>> {
    const server = createServer();
    serveTunnel(server, { ...deps, warn: () => undefined });
    const listened = await listen(server, 0);
    if (!listened.ok) {
        return listened;
    }
    try {
        return await prepareThrough(listened.value, deps);
    } finally {
        server.close();
    }
}

async function prepareThrough(port: number, deps: PrepareDeps): Promise<Result<void, string>> {
    const { proxy } = deps;
    const client = () =>
        new pg.Client({ host: LISTEN_HOST, port, user: proxy.user, password: proxy.password, database: proxy.database, ssl: false, connectionTimeoutMillis: 20_000 });
    const deadline = Date.now() + (deps.waitMs ?? ROLE_WAIT_MS);
    let reported = false;
    for (;;) {
        // The tunnel first: a refusal is final, and a pg error would hide it.
        const token = await deps.token();
        if (!token.ok) {
            return token;
        }
        const probe = await openTunnel(deps.url, token.value);
        if (!probe.ok && probe.error.kind === 'refused') {
            return err(tunnelErrorMessage(probe.error));
        }
        if (probe.ok) {
            probe.value.terminate();
            const login = client();
            const connected = await login.connect().then(
                () => ok(undefined),
                (error: unknown) => err(error instanceof Error ? error.message : String(error)),
            );
            if (connected.ok) {
                const prepared = await actAsApp(login, client, proxy.access);
                await login.end().catch(() => undefined);
                return prepared;
            }
            await login.end().catch(() => undefined);
            if (Date.now() >= deadline) {
                return err(`cannot log in as ${proxy.user}: ${connected.error}`);
            }
        } else if (Date.now() >= deadline) {
            return err(tunnelErrorMessage(probe.error));
        }
        if (!reported) {
            deps.report('Waiting for your role and the tunnel (the first time takes up to a minute or two)…');
            reported = true;
        }
        await sleep(deps.retryMs ?? RETRY_MS);
    }
}

/** pg rejects on every failure; this turns one call into a Result naming the SQLSTATE. */
const attempt = <T>(work: () => Promise<T>): Promise<Result<T, string>> =>
    work().then(
        (value) => ok(value),
        (error: unknown) => {
            const state = sqlState(error);
            return err(`${state === undefined ? '' : `${state}: `}${error instanceof Error ? error.message : String(error)}`);
        },
    );

const currentUser = async (connection: pg.Client): Promise<string | undefined> =>
    (await connection.query<{ current_user: string }>('select current_user')).rows[0]?.current_user;

/**
 * At `owner`: `app` as the role's default role, set by the role itself and
 * checked on a new login. A role that acts as `app` already is left alone:
 * `ALTER ROLE CURRENT_USER` would then change `app`.
 */
async function actAsApp(login: pg.Client, client: () => pg.Client, access: DatabaseAccess): Promise<Result<void, string>> {
    if (access !== 'owner') {
        return ok(undefined);
    }
    const before = await attempt(() => currentUser(login));
    if (!before.ok) {
        return err(`cannot make the role act as app: ${before.error}`);
    }
    if (before.value !== 'app') {
        const set = await attempt(() => login.query(`ALTER ROLE CURRENT_USER SET role = 'app'`));
        if (!set.ok) {
            return err(`cannot make the role act as app: ${set.error}`);
        }
    }
    const check = client();
    const acting = await attempt(async () => {
        await check.connect();
        return currentUser(check);
    });
    await check.end().catch(() => undefined);
    if (!acting.ok) {
        return err(`cannot check that the role acts as app: ${acting.error}`);
    }
    return acting.value === 'app' ? ok(undefined) : err(`the role does not act as app after setting it (it acts as ${acting.value})`);
}
