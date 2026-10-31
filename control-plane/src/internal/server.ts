/**
 * The internal API for the operators and the billing service
 * (ARCHITECTURE.md, "Operators" and "Billing"): its own port, reachable only
 * inside the cluster, never routed by ingress. Every request carries a
 * ServiceAccount token; each route answers only the ServiceAccounts listed
 * for it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
    type AccountRecord,
    DNS_LABEL,
    type DatabaseRow,
    type DomainRouting,
    INTERNAL_ACCOUNTS_PATH,
    INTERNAL_DATABASES_PATH,
    INTERNAL_ROUTES_PATH,
    UUID,
} from '@openupstream/sdk';
import type { Authenticate } from './auth.js';

export interface InternalApi {
    readonly authenticate: Authenticate;
    /** Usernames allowed to list Databases, e.g. `system:serviceaccount:openupstream-system:databases-operator`. */
    readonly allowedCallers: ReadonlySet<string>;
    /** Usernames allowed to read Accounts and place or lift their Holds: the billing service. */
    readonly billingCallers: ReadonlySet<string>;
    /** Usernames allowed to list the routing table: the Routes operator. */
    readonly routesCallers: ReadonlySet<string>;
    readonly listDatabaseRows: () => Promise<readonly DatabaseRow[]>;
    readonly listDomainRoutings: () => Promise<readonly DomainRouting[]>;
    readonly getAccount: (id: string) => Promise<AccountRecord | undefined>;
    /** False if there is no such Account. */
    readonly placeHold: (accountId: string, reason: string) => Promise<boolean>;
    /** False if there is no such Account. */
    readonly liftHold: (accountId: string, reason: string) => Promise<boolean>;
    readonly log?: (entry: Record<string, unknown>) => void;
}

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

/** The route for a path, or undefined; malformed ids and reasons match nothing. */
function routeFor(api: InternalApi, path: string): Route | undefined {
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
    return undefined;
}

async function handle(api: InternalApi, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const route = routeFor(api, new URL(req.url ?? '/', 'http://internal').pathname);
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
