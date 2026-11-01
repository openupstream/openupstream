/**
 * The notes demo as pure parts: a note's validation, the page, and the
 * request handler over a store, so the tests need no database.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readBody, send, sendJson } from '../shared/http.js';

export const MAX_NOTE_LENGTH = 1000;
const MAX_BODY_BYTES = 8 * 1024;
const LISTED = 50;

export interface Note {
    readonly id: string;
    readonly body: string;
    readonly createdAt: string;
}

export interface NotesStore {
    /** The newest notes first, at most `limit`. */
    list(limit: number): Promise<Note[]>;
    add(body: string): Promise<Note>;
    /** Whether the database answers. */
    ping(): Promise<boolean>;
}

export type Parsed = { readonly ok: true; readonly body: string } | { readonly ok: false; readonly error: string };

export function parseNote(text: string | undefined): Parsed {
    const body = text?.trim() ?? '';
    if (body === '') {
        return { ok: false, error: 'a note needs some text' };
    }
    return body.length > MAX_NOTE_LENGTH ? { ok: false, error: `a note has at most ${MAX_NOTE_LENGTH} characters` } : { ok: true, body };
}

const escapeHtml = (text: string): string =>
    text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);

export const renderPage = (notes: readonly Note[], error?: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notes</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}textarea{width:100%;min-height:4rem}li{margin:.5rem 0}time{color:#666;font-size:.85em}</style>
</head>
<body>
<h1>Notes</h1>
<p>A demo app on openupstream: a Service with a Postgres Database.</p>
<form method="post" action="/notes">
<textarea name="body" maxlength="${MAX_NOTE_LENGTH}" required></textarea>
<button>Add note</button>
</form>
${error === undefined ? '' : `<p role="alert">${escapeHtml(error)}</p>`}
<ul>
${notes.map((note) => `<li>${escapeHtml(note.body)} <time datetime="${note.createdAt}">${note.createdAt}</time></li>`).join('\n')}
</ul>
</body>
</html>
`;

/** Answers every request; a failing database is a 503, never a crash. */
export function notesHandler(store: NotesStore) {
    const routes = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        const path = new URL(request.url ?? '/', 'http://notes').pathname;
        const route = `${request.method} ${path}`;
        switch (route) {
            case 'GET /healthz':
                return send(response, 200, 'ok');
            case 'GET /readyz':
                return (await store.ping()) ? send(response, 200, 'ok') : send(response, 503, 'no database');
            case 'GET /':
                return send(response, 200, renderPage(await store.list(LISTED)), 'text/html; charset=utf-8');
            case 'GET /api/notes':
                return sendJson(response, 200, await store.list(LISTED));
            case 'POST /notes': {
                const parsed = parseNote(new URLSearchParams((await readBody(request, MAX_BODY_BYTES)) ?? '').get('body') ?? undefined);
                if (!parsed.ok) {
                    return send(response, 400, renderPage(await store.list(LISTED), parsed.error), 'text/html; charset=utf-8');
                }
                await store.add(parsed.body);
                response.writeHead(303, { location: '/' });
                return void response.end();
            }
            case 'POST /api/notes': {
                const text = await readBody(request, MAX_BODY_BYTES);
                const json = text === undefined ? undefined : (JSON.parse(text === '' ? '{}' : text) as unknown);
                const parsed = parseNote(typeof json === 'object' && json !== null && 'body' in json && typeof json.body === 'string' ? json.body : undefined);
                return parsed.ok ? sendJson(response, 201, await store.add(parsed.body)) : sendJson(response, 400, { error: parsed.error });
            }
            default:
                return send(response, 404, 'not found');
        }
    };
    return (request: IncomingMessage, response: ServerResponse): Promise<void> =>
        routes(request, response).catch((error: unknown) => {
            const unparsable = error instanceof SyntaxError;
            if (!response.headersSent) {
                unparsable ? sendJson(response, 400, { error: 'the body is not JSON' }) : send(response, 503, 'the database is not available');
            }
            if (!unparsable) {
                console.error(JSON.stringify({ time: new Date().toISOString(), msg: 'request failed', error: String(error) }));
            }
        });
}
