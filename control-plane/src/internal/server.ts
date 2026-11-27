/**
 * The internal API for the operators, the billing service and madAuth's
 * sidecar (ARCHITECTURE.md, "Operators", "Billing" and "Control plane"): its own port, reachable only
 * inside the cluster, never routed by ingress. Every request carries a
 * ServiceAccount token; each route answers only the ServiceAccounts listed
 * for it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
    type AccountRecord,
    type AccountUsage,
    DNS_LABEL,
    type DatabaseRow,
    type DomainRouting,
    type JobRow,
    INTERNAL_ACCOUNTS_PATH,
    INTERNAL_DATABASES_PATH,
    INTERNAL_JOBS_PATH,
    INTERNAL_ROUTES_PATH,
    INTERNAL_SERVICES_PATH,
    INTERNAL_USERS_PATH,
    MADAUTH_ID,
    type ServiceRow,
    UUID,
} from '@openupstream/sdk';
import type { Authenticate } from './auth.js';
import type { Result } from '../result.js';

export interface InternalApi {
    readonly authenticate: Authenticate;
    /** Usernames allowed to list Databases, e.g. `system:serviceaccount:openupstream-system:databases-operator`. */
    readonly allowedCallers: ReadonlySet<string>;
    /** Usernames allowed to read Accounts and place or lift their Holds: the billing service. */
    readonly billingCallers: ReadonlySet<string>;
    /** Usernames allowed to list the routing table: the Routes operator. */
    readonly routesCallers: ReadonlySet<string>;
    /** Usernames allowed to list Services: the Services operator. */
    readonly servicesCallers: ReadonlySet<string>;
    /** Usernames allowed to list Jobs: the Jobs operator. */
    readonly jobsCallers: ReadonlySet<string>;
    /** Usernames allowed to pass on madAuth's deleted users and revoked API keys: madAuth's sidecar. */
    readonly madauthCallers: ReadonlySet<string>;
    readonly listDatabaseRows: () => Promise<readonly DatabaseRow[]>;
    readonly listDomainRoutings: () => Promise<readonly DomainRouting[]>;
    /** An error when the default Site, where a Service or Job without a Home site goes, cannot be read. */
    readonly listServiceRows: () => Promise<Result<readonly ServiceRow[], string>>;
    readonly listJobRows: () => Promise<Result<readonly JobRow[], string>>;
    readonly getAccount: (id: string) => Promise<AccountRecord | undefined>;
    /** The Account's usage of a month (`YYYY-MM`); undefined for a malformed month. */
    readonly accountUsage: (accountId: string, month: string) => Promise<AccountUsage | undefined>;
    /** False if there is no such Account. */
    readonly placeHold: (accountId: string, reason: string) => Promise<boolean>;
    /** False if there is no such Account. */
    readonly liftHold: (accountId: string, reason: string) => Promise<boolean>;
    /** Removes a deleted madAuth user from every Account; nothing to do is no error. */
    readonly removeUser: (subject: string) => Promise<void>;
    /** Drops a revoked API key's Postgres roles; nothing to do is no error. */
    readonly revokeApiKey: (subject: string, apiKeyId: string) => Promise<void>;
    readonly log?: (entry: Record<string, unknown>) => void;
}

/** 503 when the rows cannot be made now; the operator tries again on its next pass. */
const rowsReply = (rows: Result<readonly unknown[], string>, log: InternalApi['log']): Reply => {
    if (!rows.ok) {
        log?.({ msg: 'cannot list the rows', error: rows.error });
        return { status: 503, body: { error: rows.error } };
    }
    return { status: 200, body: rows.value };
};

interface Reply {
    readonly status: number;
    readonly body?: unknown;
}

interface Route {
    readonly methods: readonly string[];
    readonly callers: ReadonlySet<string>;
    readonly handle: (method: string) => Promise<Reply>;
}

const notFound: Reply = { status: 404, body: { error: 'not found' } };

const send = (res: ServerResponse, reply: Reply): void => {
    if (reply.body === undefined) {
        res.writeHead(reply.status);
        res.end();
        return;
    }
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
};

const bearerToken = (req: IncomingMessage): string | undefined =>
    /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];

const accountPath = new RegExp(`^${INTERNAL_ACCOUNTS_PATH}/([^/]+)$`);
const holdPath = new RegExp(`^${INTERNAL_ACCOUNTS_PATH}/([^/]+)/holds/([^/]+)$`);
const usagePath = new RegExp(`^${INTERNAL_ACCOUNTS_PATH}/([^/]+)/usage$`);
const userPath = new RegExp(`^${INTERNAL_USERS_PATH}/([^/]+)$`);
const apiKeyPath = new RegExp(`^${INTERNAL_USERS_PATH}/([^/]+)/api-keys/([^/]+)$`);

/** The route for a path, or undefined; malformed ids and reasons match nothing. */
function routeFor(api: InternalApi, path: string, query: URLSearchParams): Route | undefined {
    if (path === INTERNAL_DATABASES_PATH) {
        return {
            methods: ['GET'],
            callers: api.allowedCallers,
            handle: async () => ({ status: 200, body: await api.listDatabaseRows() }),
        };
    }
    if (path === INTERNAL_ROUTES_PATH) {
        return {
            methods: ['GET'],
            callers: api.routesCallers,
            handle: async () => ({ status: 200, body: await api.listDomainRoutings() }),
        };
    }
    if (path === INTERNAL_SERVICES_PATH) {
        return {
            methods: ['GET'],
            callers: api.servicesCallers,
            handle: async () => rowsReply(await api.listServiceRows(), api.log),
        };
    }
    if (path === INTERNAL_JOBS_PATH) {
        return {
            methods: ['GET'],
            callers: api.jobsCallers,
            handle: async () => rowsReply(await api.listJobRows(), api.log),
        };
    }
    const account = accountPath.exec(path);
    if (account?.[1] !== undefined && UUID.test(account[1])) {
        const id = account[1];
        return {
            methods: ['GET'],
            callers: api.billingCallers,
            handle: async () => {
                const record = await api.getAccount(id);
                return record === undefined ? notFound : { status: 200, body: record };
            },
        };
    }
    const usage = usagePath.exec(path);
    if (usage?.[1] !== undefined && UUID.test(usage[1])) {
        const id = usage[1];
        return {
            methods: ['GET'],
            callers: api.billingCallers,
            handle: async () => {
                const month = query.get('month') ?? '';
                if ((await api.getAccount(id)) === undefined) {
                    return notFound;
                }
                const found = await api.accountUsage(id, month);
                return found === undefined ? { status: 400, body: { error: 'month must be YYYY-MM' } } : { status: 200, body: found };
            },
        };
    }
    const hold = holdPath.exec(path);
    if (hold?.[1] !== undefined && hold[2] !== undefined && UUID.test(hold[1]) && DNS_LABEL.test(hold[2])) {
        const [, id, reason] = hold;
        return {
            methods: ['PUT', 'DELETE'],
            callers: api.billingCallers,
            handle: async (method) => {
                const found = method === 'PUT' ? await api.placeHold(id, reason) : await api.liftHold(id, reason);
                return found ? { status: 204 } : notFound;
            },
        };
    }
    const user = userPath.exec(path);
    if (user?.[1] !== undefined && MADAUTH_ID.test(user[1])) {
        const subject = user[1];
        return {
            methods: ['DELETE'],
            callers: api.madauthCallers,
            handle: async () => {
                await api.removeUser(subject);
                return { status: 204 };
            },
        };
    }
    const apiKey = apiKeyPath.exec(path);
    if (apiKey?.[1] !== undefined && apiKey[2] !== undefined && MADAUTH_ID.test(apiKey[1]) && MADAUTH_ID.test(apiKey[2])) {
        const [, subject, keyId] = apiKey;
        return {
            methods: ['DELETE'],
            callers: api.madauthCallers,
            handle: async () => {
                await api.revokeApiKey(subject, keyId);
                return { status: 204 };
            },
        };
    }
    return undefined;
}

async function handle(api: InternalApi, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://internal');
    const route = routeFor(api, url.pathname, url.searchParams);
    if (route === undefined) {
        return send(res, notFound);
    }
    const method = req.method ?? 'GET';
    if (!route.methods.includes(method)) {
        res.setHeader('allow', route.methods.join(', '));
        return send(res, { status: 405, body: { error: 'method not allowed' } });
    }
    const token = bearerToken(req);
    if (token === undefined) {
        return send(res, { status: 401, body: { error: 'bearer token required' } });
    }
    const caller = await api.authenticate(token);
    if (!caller.ok) {
        api.log?.({ msg: 'internal api: authentication failed', error: caller.error });
        return caller.error.kind === 'review-failed'
            ? send(res, { status: 503, body: { error: 'cannot check the token now' } })
            : send(res, { status: 401, body: { error: 'invalid token' } });
    }
    if (!route.callers.has(caller.value.username)) {
        api.log?.({ msg: 'internal api: caller not allowed', username: caller.value.username });
        return send(res, { status: 403, body: { error: 'caller not allowed' } });
    }
    const reply = await route.handle(method);
    if (method !== 'GET') {
        api.log?.({ msg: 'internal api: changed', method, path: req.url, caller: caller.value.username, status: reply.status });
    }
    return send(res, reply);
}

export function createInternalServer(api: InternalApi): Server {
    return createServer((req, res) => {
        handle(api, req, res).catch((error: unknown) => {
            api.log?.({ msg: 'internal api: request failed', error: error instanceof Error ? error.message : String(error) });
            if (!res.headersSent) {
                send(res, { status: 500, body: { error: 'internal error' } });
            }
        });
    });
}
