import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { contentType, fileName, type FileInfo, type FilesStore, filesHandler, MAX_FILE_BYTES, type StoredFile } from './files.js';
import { bucketClient } from './store.js';

const memoryStore = (failing = false): FilesStore & { files: Map<string, StoredFile> } => {
    const files = new Map<string, StoredFile>();
    const guard = <T>(value: () => T): Promise<T> => (failing ? Promise.reject(new Error('connection refused')) : Promise.resolve(value()));
    const info = (name: string, file: StoredFile): FileInfo => ({ name, size: file.body.length, lastModified: '2026-11-01T12:00:00.000Z' });
    return {
        files,
        list: (limit) => guard(() => [...files].sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([name, file]) => info(name, file))),
        get: (name) => guard(() => files.get(name)),
        put: (name, body, type) =>
            guard(() => {
                files.set(name, { body, contentType: type });
                return info(name, { body, contentType: type });
            }),
        delete: (name) => guard(() => void files.delete(name)),
        ping: async () => !failing,
    };
};

async function serve(store: FilesStore): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createServer(filesHandler(store));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

test('a file name is a safe path segment', () => {
    assert.equal(fileName('/api/files/report-2026.pdf'), 'report-2026.pdf');
    assert.equal(fileName('/api/files/a%2Eb'), 'a.b');
    assert.equal(fileName('/api/files/.env'), undefined);
    assert.equal(fileName('/api/files/a%2Fb'), undefined);
    assert.equal(fileName('/api/files/a b'), undefined);
    assert.equal(fileName('/api/files/%E0%A4%A'), undefined);
    assert.equal(fileName(`/api/files/${'x'.repeat(101)}`), undefined);
    assert.equal(fileName('/api/files/a/b'), undefined);
});

test('an upload keeps its media type, without parameters', () => {
    assert.equal(contentType('text/plain; charset=utf-8'), 'text/plain');
    assert.equal(contentType('IMAGE/PNG'), 'image/png');
    assert.equal(contentType(undefined), 'application/octet-stream');
    assert.equal(contentType('text/html\r\nx-evil: 1'), 'application/octet-stream');
});

test('the client signs for the Bucket at its own hostname', async () => {
    const { s3, bucket } = bucketClient({ endpoint: 'https://uploads-1.s3.dev.openupstream.app', region: 'garage', accessKeyId: 'GK1', secretAccessKey: 's' });
    assert.equal(bucket, 'uploads-1');
    const endpoint = await s3.config.endpoint?.();
    assert.equal(`${endpoint?.protocol}//${endpoint?.hostname}`, 'https://s3.dev.openupstream.app');
    assert.equal(await s3.config.region(), 'garage');
});

test('files are stored, listed, downloaded and deleted', async () => {
    const store = memoryStore();
    const { url, close } = await serve(store);
    const put = await fetch(`${url}/api/files/hello.txt`, { method: 'PUT', body: 'hi', headers: { 'content-type': 'text/plain; charset=utf-8' } });
    assert.equal(put.status, 200);
    assert.deepEqual(((await put.json()) as FileInfo).size, 2);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
    assert.equal((await fetch(`${url}/api/files/a.png`, { method: 'PUT', body: png, headers: { 'content-type': 'image/png' } })).status, 200);
    const listed = (await (await fetch(`${url}/api/files`)).json()) as FileInfo[];
    assert.deepEqual(listed.map((file) => file.name), ['a.png', 'hello.txt']);
    const download = await fetch(`${url}/api/files/a.png`);
    assert.equal(download.headers.get('content-type'), 'image/png');
    assert.equal(download.headers.get('content-disposition'), 'attachment; filename="a.png"');
    assert.equal(download.headers.get('content-security-policy'), 'sandbox');
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), png);
    assert.equal((await fetch(`${url}/api/files/a.png`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${url}/api/files/a.png`)).status, 404);
    await close();
});

test('bad requests are a 400, 404, 405 or 413', async () => {
    const { url, close } = await serve(memoryStore());
    assert.equal((await fetch(`${url}/api/files/.hidden`, { method: 'PUT', body: 'x' })).status, 400);
    assert.equal((await fetch(`${url}/api/files/big.bin`, { method: 'PUT', body: new Uint8Array(MAX_FILE_BYTES + 1) })).status, 413);
    assert.equal((await fetch(`${url}/api/files/ok.bin`, { method: 'PUT', body: new Uint8Array(MAX_FILE_BYTES) })).status, 200);
    assert.equal((await fetch(`${url}/api/files/ok.bin`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${url}/files`)).status, 404);
    assert.equal((await fetch(`${url}/api/nope`)).status, 404);
    await close();
});

test('without the Bucket: a 503 for its routes, the process stays healthy', async () => {
    const { url, close } = await serve(memoryStore(true));
    assert.equal((await fetch(`${url}/api/files`)).status, 503);
    assert.equal((await fetch(`${url}/api/files/a.txt`, { method: 'PUT', body: 'x' })).status, 503);
    assert.equal((await fetch(`${url}/readyz`)).status, 503);
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    await close();
});
