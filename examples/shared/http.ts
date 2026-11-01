/**
 * What the demo apps share: a JSON log line, reading a request body with a
 * limit, and answering. Plain node:http, so each app shows what the
 * platform needs from a container and nothing else.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export const log = (entry: Record<string, unknown>): void => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

/** The body as text, or undefined when it is longer than `limit` bytes. */
export async function readBody(request: IncomingMessage, limit: number): Promise<string | undefined> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        size += (chunk as Buffer).length;
        if (size > limit) {
            return undefined;
        }
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}

export function send(response: ServerResponse, status: number, body: string, contentType = 'text/plain; charset=utf-8'): void {
    response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
    response.end(body);
}

export const sendJson = (response: ServerResponse, status: number, value: unknown): void =>
    send(response, status, JSON.stringify(value), 'application/json');

/** The port to listen on: `PORT`, else 8080. */
export const portFromEnv = (env: NodeJS.ProcessEnv = process.env): number => Number(env['PORT'] ?? 8080);
