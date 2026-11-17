/**
 * The database tunnel's forwarder (ARCHITECTURE.md, decision 126; ADR-0005):
 * one pod per Project that has used `oup pg proxy`, behind Traefik, which
 * has asked the control plane about the caller before the request gets
 * here. Each WebSocket carries one Postgres connection: its binary messages
 * are the bytes, copied both ways to the Database the path names, at its
 * Pooler (`/databases/<id>/pooler`) or its primary (`/databases/<id>/primary`,
 * the Cluster's read-write Service). It holds no credentials and checks
 * nothing else: the client logs in to Postgres with its own role.
 *
 * `GET /healthz` answers 200 for the readiness probe; anything else 404.
 */
import { type IncomingMessage, type Server, createServer } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream';
import { TUNNEL_PATH, poolerName, primaryServiceName } from '@openupstream/sdk';
import { type WebSocket, WebSocketServer, createWebSocketStream } from 'ws';

export interface Target {
    readonly host: string;
    readonly port: number;
}

/** Where a tunnel's path leads in `namespace`, or undefined for any other path. */
export const targetOf = (path: string, namespace: string): Target | undefined => {
    const match = TUNNEL_PATH.exec(path);
    if (match?.[1] === undefined) {
        return undefined;
    }
    const database = { id: match[1] };
    const service = match[2] === 'primary' ? primaryServiceName(database) : poolerName(database);
    return { host: `${service}.${namespace}.svc.cluster.local`, port: 5432 };
};

/** Pings keep Traefik and the client from taking a quiet tunnel (an idle psql) for a dead one. */
export const PING_INTERVAL_MS = 30_000;
/** A Postgres message larger than this is split by the sender anyway; it bounds what one frame may hold. */
const MAX_PAYLOAD_BYTES = 1 << 20;

export interface ForwarderOptions {
    readonly resolve: (path: string) => Target | undefined;
    readonly log: (entry: Record<string, unknown>) => void;
    readonly pingIntervalMs?: number;
}

const refuse = (socket: Duplex, status: string): void => {
    socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
};

/** The forwarder's HTTP server, not yet listening. */
export function createForwarder(options: ForwarderOptions): Server {
    const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES, perMessageDeflate: false });
    const server = createServer((req, res) => {
        res.writeHead(req.url === '/healthz' ? 200 : 404).end();
    });
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        const path = new URL(req.url ?? '/', 'http://forwarder').pathname;
        const target = options.resolve(path);
        if (target === undefined) {
            refuse(socket, '404 Not Found');
            return;
        }
        sockets.handleUpgrade(req, socket, head, (ws) => bridge(ws, target, path, options));
    });
    return server;
}

function bridge(ws: WebSocket, target: Target, path: string, options: ForwarderOptions): void {
    const started = Date.now();
    const upstream = connect(target);
    upstream.setNoDelay(true);
    upstream.setKeepAlive(true, PING_INTERVAL_MS);
    const ping = setInterval(() => ws.ping(), options.pingIntervalMs ?? PING_INTERVAL_MS);
    const stream = createWebSocketStream(ws);
    options.log({ msg: 'tunnel opened', path });
    pipeline(stream, upstream, stream, (error) => {
        clearInterval(ping);
        ws.terminate();
        upstream.destroy();
        options.log({
            msg: 'tunnel closed',
            path,
            seconds: Math.round((Date.now() - started) / 1000),
            bytesToDatabase: upstream.bytesWritten,
            bytesFromDatabase: upstream.bytesRead,
            ...(error === undefined || error === null ? {} : { error: error.message }),
        });
    });
}
