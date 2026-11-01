import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MAX_NOTE_LENGTH, type Note, type NotesStore, notesHandler, parseNote, renderPage } from './notes.js';

const memoryStore = (failing = false): NotesStore & { notes: Note[] } => {
    const notes: Note[] = [];
    const fail = () => Promise.reject(new Error('connection refused'));
    return {
        notes,
        list: async (limit) => (failing ? fail() : [...notes].reverse().slice(0, limit)),
        add: async (body) => {
            if (failing) {
                return fail();
            }
            const note = { id: String(notes.length + 1), body, createdAt: '2026-11-01T12:00:00.000Z' };
            notes.push(note);
            return note;
        },
        ping: async () => !failing,
    };
};

async function serve(store: NotesStore): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer(notesHandler(store));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test('a note is trimmed text of at most 1000 characters', () => {
    assert.deepEqual(parseNote('  milk  '), { ok: true, body: 'milk' });
    assert.equal(parseNote('   ').ok, false);
    assert.equal(parseNote(undefined).ok, false);
    assert.equal(parseNote('x'.repeat(MAX_NOTE_LENGTH)).ok, true);
    assert.equal(parseNote('x'.repeat(MAX_NOTE_LENGTH + 1)).ok, false);
});

test('the page escapes what users wrote', () => {
    const page = renderPage([{ id: '1', body: '<script>alert("x")</script>', createdAt: '2026-11-01T12:00:00.000Z' }]);
    assert.ok(!page.includes('<script>alert'));
    assert.ok(page.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
});

test('notes are added through the JSON API and the form, and listed newest first', async () => {
    const store = memoryStore();
    const { url, close } = await serve(store);
    const created = await fetch(`${url}/api/notes`, { method: 'POST', body: JSON.stringify({ body: 'first' }) });
    assert.equal(created.status, 201);
    assert.deepEqual(((await created.json()) as Note).body, 'first');
    const form = await fetch(`${url}/notes`, { method: 'POST', body: new URLSearchParams({ body: 'second' }), redirect: 'manual' });
    assert.equal(form.status, 303);
    assert.equal(form.headers.get('location'), '/');
    const listed = (await (await fetch(`${url}/api/notes`)).json()) as Note[];
    assert.deepEqual(listed.map((note) => note.body), ['second', 'first']);
    assert.match(await (await fetch(url)).text(), /second[\s\S]*first/);
    await close();
});

test('bad input is a 400, an unknown path a 404', async () => {
    const { url, close } = await serve(memoryStore());
    assert.equal((await fetch(`${url}/api/notes`, { method: 'POST', body: '{"body":""}' })).status, 400);
    assert.equal((await fetch(`${url}/api/notes`, { method: 'POST', body: 'not json' })).status, 400);
    assert.equal((await fetch(`${url}/notes`, { method: 'POST', body: new URLSearchParams({ body: ' ' }) })).status, 400);
    assert.equal((await fetch(`${url}/api/notes`, { method: 'POST', body: JSON.stringify({ body: 'x'.repeat(9000) }) })).status, 413);
    assert.equal((await fetch(`${url}/notes`, { method: 'POST', body: new URLSearchParams({ body: 'x'.repeat(9000) }) })).status, 413);
    assert.equal((await fetch(`${url}/nope`)).status, 404);
    await close();
});

test('without the database: a 503 for its routes, the process stays healthy', async () => {
    const { url, close } = await serve(memoryStore(true));
    assert.equal((await fetch(`${url}/api/notes`, { method: 'POST', body: '{"body":"x"}' })).status, 503);
    assert.equal((await fetch(url)).status, 503);
    assert.equal((await fetch(`${url}/readyz`)).status, 503);
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    await close();
});
