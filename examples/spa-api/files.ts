/**
 * The spa-api demo's API as pure parts: a file name's validation and the
 * request handler over a store, so the tests need no Bucket. The routes
 * keep their `/api` prefix, since a Route to a Service passes the path on
 * unchanged (decision 93).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { log, readBytes, send, sendJson } from '../shared/http.js';

export const MAX_FILE_BYTES = 1024 * 1024;
const LISTED = 100;

export interface FileInfo {
    readonly name: string;
    readonly size: number;
    readonly lastModified: string;
}

export interface StoredFile {
    readonly body: Uint8Array;
    readonly contentType: string;
}

export interface FilesStore {
    /** The files by name, at most `limit`. */
    list(limit: number): Promise<FileInfo[]>;
    /** The file, or undefined when there is none of that name. */
    get(name: string): Promise<StoredFile | undefined>;
    /** Stores the file, replacing one of the same name. */
    put(name: string, body: Uint8Array, contentType: string): Promise<FileInfo>;
    delete(name: string): Promise<void>;
    /** Whether the Bucket answers. */
    ping(): Promise<boolean>;
}

/** A name that is safe as an object key, a path segment and a download name. */
export const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CONTENT_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

/** The file name in a `/api/files/<name>` path, or undefined for another path or a bad name. */
export function fileName(path: string): string | undefined {
    const match = /^\/api\/files\/([^/]+)$/.exec(path);
    const name = match?.[1] === undefined ? undefined : decodeName(match[1]);
    return name !== undefined && FILE_NAME.test(name) ? name : undefined;
}

/** decodeURIComponent only reports a bad escape by throwing, so the catch stays here. */
const decodeName = (segment: string): string | undefined => {
    try {
        return decodeURIComponent(segment);
    } catch {
        return undefined;
    }
};

/** The media type of an upload without its parameters, or `application/octet-stream`. */
export function contentType(header: string | undefined): string {
    const type = header?.split(';')[0]?.trim().toLowerCase() ?? '';
    return CONTENT_TYPE.test(type) ? type : 'application/octet-stream';
}

/**
 * Downloads never render on the SPA's origin: an uploaded HTML page would
 * otherwise run its scripts there. Images still load in an <img>.
 */
const downloadHeaders = (name: string, file: StoredFile) => ({
    'content-type': file.contentType,
    'content-length': String(file.body.length),
    'content-disposition': `attachment; filename="${name}"`,
    'content-security-policy': 'sandbox',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
});

/** Answers every request; a failing Bucket is a 503, never a crash. */
export function filesHandler(store: FilesStore) {
    const routes = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        const path = new URL(request.url ?? '/', 'http://spa-api').pathname;
        switch (`${request.method} ${path}`) {
            case 'GET /healthz':
                return send(response, 200, 'ok');
            case 'GET /readyz':
                return (await store.ping()) ? send(response, 200, 'ok') : send(response, 503, 'no bucket');
            case 'GET /api/files':
                return sendJson(response, 200, await store.list(LISTED));
        }
        if (!path.startsWith('/api/files/')) {
            return sendJson(response, 404, { error: 'not found' });
        }
        const name = fileName(path);
        if (name === undefined) {
            return sendJson(response, 400, { error: 'a file name has 1 to 100 letters, digits, dots, dashes or underscores' });
        }
        switch (request.method) {
            case 'GET': {
                const file = await store.get(name);
                if (file === undefined) {
                    return sendJson(response, 404, { error: 'no such file' });
                }
                response.writeHead(200, downloadHeaders(name, file));
                return void response.end(file.body);
            }
            case 'PUT': {
                const body = await readBytes(request, MAX_FILE_BYTES);
                if (body === undefined) {
                    return sendJson(response, 413, { error: `a file has at most ${MAX_FILE_BYTES} bytes` });
                }
                return sendJson(response, 200, await store.put(name, body, contentType(request.headers['content-type'])));
            }
            case 'DELETE':
                await store.delete(name);
                return void response.writeHead(204).end();
            default:
                response.setHeader('allow', 'GET, PUT, DELETE');
                return sendJson(response, 405, { error: 'method not allowed' });
        }
    };
    return (request: IncomingMessage, response: ServerResponse): Promise<void> =>
        routes(request, response).catch((error: unknown) => {
            if (!response.headersSent) {
                sendJson(response, 503, { error: 'the bucket is not available' });
            }
            log({ msg: 'request failed', error: String(error) });
        });
}
