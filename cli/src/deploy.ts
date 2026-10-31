/**
 * `oup site deploy` (ARCHITECTURE.md, "Static sites"; decision 88): uploads
 * a built site to a Bucket with the cache headers Garage then serves, and
 * makes the Bucket mirror the directory.
 *
 * Order: every other file first, the `index.html` files last, so a client
 * that loads the new `index.html` finds the assets it names; then the
 * objects the directory no longer has are deleted, unless `keep`.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';

export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const NO_CACHE = 'no-cache';
export const SHORT = 'public, max-age=300';

/**
 * A content hash in the name, as bundlers write it: `app.3f2a9c1b.js`,
 * `index-BXk3a9Zp.css`. At least eight characters with a digit, so
 * `jquery-migration.js` is not taken for one.
 */
const HASHED = /[.-](?=[A-Za-z0-9_]*\d)[A-Za-z0-9_]{8,}\.[A-Za-z0-9]+$/;

const baseName = (key: string): string => key.slice(key.lastIndexOf('/') + 1);

export const cacheControlFor = (key: string): string =>
    baseName(key) === 'index.html' ? NO_CACHE : HASHED.test(baseName(key)) ? IMMUTABLE : SHORT;

const TYPES: Readonly<Record<string, string>> = {
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    json: 'application/json',
    map: 'application/json',
    webmanifest: 'application/manifest+json',
    txt: 'text/plain; charset=utf-8',
    xml: 'application/xml',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    ico: 'image/x-icon',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf',
    wasm: 'application/wasm',
    pdf: 'application/pdf',
    mp4: 'video/mp4',
    webm: 'video/webm',
};

export const contentTypeFor = (key: string): string => {
    const name = baseName(key);
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    return TYPES[extension] ?? 'application/octet-stream';
};

export interface LocalFile {
    readonly key: string;
    readonly path: string;
    /** Hex MD5, what Garage answers as the ETag of an object uploaded in one part. */
    readonly md5: string;
}

export interface RemoteObject {
    readonly key: string;
    readonly etag: string | undefined;
}

export interface DeployPlan {
    /** In upload order: the `index.html` files last. */
    readonly uploads: readonly LocalFile[];
    readonly unchanged: number;
    readonly deletions: readonly string[];
}

/** Pure: what to upload (changed files only) and what to delete. */
export function planDeploy(local: readonly LocalFile[], remote: readonly RemoteObject[], keep: boolean): DeployPlan {
    const etags = new Map(remote.map((object) => [object.key, object.etag?.replaceAll('"', '')]));
    const changed = local.filter((file) => etags.get(file.key) !== file.md5);
    const isIndex = (file: LocalFile) => baseName(file.key) === 'index.html';
    const localKeys = new Set(local.map((file) => file.key));
    return {
        uploads: [...changed.filter((file) => !isIndex(file)), ...changed.filter(isIndex)],
        unchanged: local.length - changed.length,
        deletions: keep ? [] : remote.map((object) => object.key).filter((key) => !localKeys.has(key)),
    };
}

/** Every file below `dir`, keyed by its path with `/`; dotfiles are left out except `.well-known`. */
export async function listLocal(dir: string): Promise<LocalFile[]> {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name))
        .map((path) => ({ path, key: relative(dir, path).split(sep).join('/') }))
        .filter(({ key }) => !key.split('/').some((part) => part.startsWith('.') && part !== '.well-known'));
    return Promise.all(
        files.map(async ({ path, key }) => ({ key, path, md5: createHash('md5').update(await readFile(path)).digest('hex') })),
    );
}

export async function listRemote(s3: S3Client, bucket: string): Promise<RemoteObject[]> {
    const page = async (token: string | undefined): Promise<RemoteObject[]> => {
        const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
        const objects = (listed.Contents ?? []).flatMap((object) => (object.Key === undefined ? [] : [{ key: object.Key, etag: object.ETag }]));
        return listed.IsTruncated && listed.NextContinuationToken !== undefined ? [...objects, ...(await page(listed.NextContinuationToken))] : objects;
    };
    return page(undefined);
}

/** Runs `work` on every item, at most `limit` at a time, in order of starting. */
const inBatches = async <T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> => {
    for (let start = 0; start < items.length; start += limit) {
        await Promise.all(items.slice(start, start + limit).map(work));
    }
};

const UPLOADS_AT_ONCE = 8;
/** DeleteObjects takes at most this many keys. */
const DELETE_BATCH = 1000;

export async function deploy(
    s3: S3Client,
    bucket: string,
    dir: string,
    { keep, log }: { readonly keep: boolean; readonly log: (line: string) => void },
): Promise<DeployPlan> {
    const plan = planDeploy(await listLocal(dir), await listRemote(s3, bucket), keep);
    const isIndex = (file: LocalFile) => baseName(file.key) === 'index.html';
    const upload = async (file: LocalFile) => {
        await s3.send(
            new PutObjectCommand({
                Bucket: bucket,
                Key: file.key,
                Body: await readFile(file.path),
                ContentType: contentTypeFor(file.key),
                CacheControl: cacheControlFor(file.key),
            }),
        );
        log(`uploaded ${file.key}`);
    };
    // The index files only after every asset they may name is there.
    await inBatches(plan.uploads.filter((file) => !isIndex(file)), UPLOADS_AT_ONCE, upload);
    await inBatches(plan.uploads.filter(isIndex), UPLOADS_AT_ONCE, upload);
    for (let start = 0; start < plan.deletions.length; start += DELETE_BATCH) {
        const keys = plan.deletions.slice(start, start + DELETE_BATCH);
        const deleted = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
        // A 200 answer can still list keys that were not deleted.
        const failed = deleted.Errors ?? [];
        if (failed.length > 0) {
            throw new Error(`could not delete ${failed.map((error) => `${error.Key}: ${error.Message ?? error.Code}`).join(', ')}`);
        }
        keys.forEach((key) => log(`deleted ${key}`));
    }
    return plan;
}
