/**
 * The internal API for the operators (ARCHITECTURE.md, "Operators"): its own
 * port, reachable only inside the cluster, never routed by ingress. Every
 * request carries a ServiceAccount token; only the listed ServiceAccounts
 * get an answer.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type DatabaseRow, INTERNAL_DATABASES_PATH } from '@openupstream/sdk';
import type { Authenticate } from './auth.js';

export interface InternalApi {
    readonly authenticate: Authenticate;
    /** Usernames allowed to call, e.g. `system:serviceaccount:openupstream-system:databases-operator`. */
    readonly allowedCallers: ReadonlySet<string>;
    readonly listDatabaseRows: () => Promise<readonly DatabaseRow[]>;
    readonly log?: (entry: Record<string, unknown>) => void;
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
};

const bearerToken = (req: IncomingMessage): string | undefined =>
    /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];

async function handle(api: InternalApi, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://internal').pathname;
    if (path !== INTERNAL_DATABASES_PATH) {
        return send(res, 404, { error: 'not found' });
    }
    if (req.method !== 'GET') {
        res.setHeader('allow', 'GET');
        return send(res, 405, { error: 'method not allowed' });
    }
    const token = bearerToken(req);
    if (token === undefined) {
        return send(res, 401, { error: 'bearer token required' });
    }
    const caller = await api.authenticate(token);
    if (!caller.ok) {
        api.log?.({ msg: 'internal api: authentication failed', error: caller.error });
        return caller.error.kind === 'review-failed'
            ? send(res, 503, { error: 'cannot check the token now' })
            : send(res, 401, { error: 'invalid token' });
    }
    if (!api.allowedCallers.has(caller.value.username)) {
        api.log?.({ msg: 'internal api: caller not allowed', username: caller.value.username });
        return send(res, 403, { error: 'caller not allowed' });
    }
    return send(res, 200, await api.listDatabaseRows());
}

export function createInternalServer(api: InternalApi): Server {
    return createServer((req, res) => {
        handle(api, req, res).catch((error: unknown) => {
            api.log?.({ msg: 'internal api: request failed', error: error instanceof Error ? error.message : String(error) });
            if (!res.headersSent) {
                send(res, 500, { error: 'internal error' });
            }
        });
    });
}
