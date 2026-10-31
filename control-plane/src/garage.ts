/**
 * Garage, our object storage, as far as the control plane touches it
 * (ARCHITECTURE.md, "Object storage"; decisions 81 and 82): a Garage bucket
 * and a key of its own per Bucket, created through Garage's admin API (v2)
 * while the API request waits, and removed by the cleanup.
 *
 * Emptying a deleted Bucket goes through Garage's S3 API with the control
 * plane's own key, which the control plane creates in Garage the first time
 * it needs it; the Bucket's own key is deleted first, so the customer can no
 * longer write while it is emptied.
 */
import { S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';
import { type Result, err, ok } from './result.js';
import { deleteAllObjects } from './s3.js';

/** The region S3 clients sign with; Garage's `s3_region` (infra/garage). */
export const GARAGE_REGION = 'garage';

/** What a Static site serves for a directory, and for any path with SPA fallback. */
export const INDEX_DOCUMENT = 'index.html';

/** The control plane's own key in Garage, found by this name. */
export const CONTROL_PLANE_KEY_NAME = 'openupstream-control-plane';

export interface GarageConfig {
    /** The admin API inside the cluster, e.g. `http://garage.garage.svc.cluster.local:3903`. */
    readonly adminUrl: string;
    readonly adminToken: string;
    /** The S3 API inside the cluster, e.g. `http://garage.garage.svc.cluster.local:3900`. */
    readonly s3Url: string;
}

/** A Bucket's counterparts in Garage. */
export interface GarageBucket {
    readonly bucketId: string;
    readonly accessKeyId: string;
}

export type CreateBucketError = { readonly kind: 'name-taken' } | { readonly kind: 'unavailable'; readonly reason: string };

export interface ObjectStorage {
    /** A bucket with `name` as its global alias, and a key that may read and write it and nothing else. */
    createBucket(name: string): Promise<Result<GarageBucket, CreateBucketError>>;
    /** The key's secret; Garage keeps it, so it can be shown again. */
    secretOf(accessKeyId: string): Promise<Result<string, string>>;
    /**
     * Serves the bucket on Garage's website endpoint, with `index.html` for a
     * directory and, with `spaFallback`, `index.html` with status 200 for any
     * path without an object; `undefined` stops serving it (decision 84).
     */
    setWebsite(bucketId: string, website: { readonly spaFallback: boolean } | undefined): Promise<Result<void, string>>;
    /** Deletes the key, so it can no longer read or write; a key that is already gone counts as deleted. */
    deleteKey(accessKeyId: string): Promise<Result<void, string>>;
    /**
     * Deletes the key, every object and unfinished upload, then the bucket;
     * returns how many objects it deleted. What is already gone counts as
     * done, so a failed attempt can simply be repeated.
     */
    deleteBucket(bucket: GarageBucket): Promise<Result<number, string>>;
}

type Fetch = typeof fetch;

const keySchema = z.object({ accessKeyId: z.string(), name: z.string(), secretAccessKey: z.string().nullish() });
const keyListSchema = z.array(z.object({ id: z.string(), name: z.string() }));
const bucketSchema = z.object({ id: z.string() });
const problemSchema = z.object({ code: z.string().optional(), message: z.string().optional() });

/** A Garage answer that is not a 2xx: its status and code, e.g. 404 NoSuchBucket. */
interface Refusal {
    readonly status: number;
    readonly code: string;
    readonly message: string;
}

/** JSON.parse only throws; this answers. */
const parseJson = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

export function garageStorage(config: GarageConfig, options: { fetch?: Fetch } = {}): ObjectStorage {
    const doFetch = options.fetch ?? fetch;

    /** One admin API call; a refusal or an outage is an error, a malformed answer too. */
    const call = async <T>(
        method: 'GET' | 'POST',
        path: string,
        schema: z.ZodType<T>,
        body?: unknown,
    ): Promise<Result<T, Refusal | string>> => {
        const response = await doFetch(new URL(path, config.adminUrl), {
            method,
            headers: {
                authorization: `Bearer ${config.adminToken}`,
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(10_000),
        }).then(
            (value) => ok(value),
            (error: unknown) => err(`Garage unreachable: ${error instanceof Error ? error.message : String(error)}`),
        );
        if (!response.ok) {
            return response;
        }
        const text = await response.value.text();
        // Some calls (DeleteBucket, DeleteKey) answer with an empty body.
        const parsed = text === '' ? null : parseJson(text);
        if (!response.value.ok) {
            const problem = problemSchema.safeParse(parsed);
            return err({
                status: response.value.status,
                code: problem.success ? (problem.data.code ?? '') : '',
                message: problem.success ? (problem.data.message ?? text) : text,
            });
        }
        const answer = schema.safeParse(parsed);
        return answer.success ? ok(answer.data) : err(`Garage ${method} ${path}: unexpected answer`);
    };
    const describe = (error: Refusal | string): string =>
        typeof error === 'string' ? error : `Garage answered ${error.status} ${error.code}: ${error.message}`;
    const isGone = (error: Refusal | string): boolean => typeof error !== 'string' && error.status === 404;
    const anything = z.unknown();

    const deleteKey = async (accessKeyId: string): Promise<Result<void, string>> => {
        const deleted = await call('POST', `/v2/DeleteKey?id=${encodeURIComponent(accessKeyId)}`, anything);
        return deleted.ok || isGone(deleted.error) ? ok(undefined) : err(describe(deleted.error));
    };

    /** The control plane's own key with its secret, created on first use. */
    const controlPlaneKey = async (): Promise<Result<{ accessKeyId: string; secretAccessKey: string }, string>> => {
        const keys = await call('GET', '/v2/ListKeys', keyListSchema);
        if (!keys.ok) {
            return err(describe(keys.error));
        }
        const existing = keys.value.find((key) => key.name === CONTROL_PLANE_KEY_NAME);
        const key =
            existing === undefined
                ? await call('POST', '/v2/CreateKey', keySchema, { name: CONTROL_PLANE_KEY_NAME, neverExpires: true })
                : await call('GET', `/v2/GetKeyInfo?id=${encodeURIComponent(existing.id)}&showSecretKey=true`, keySchema);
        if (!key.ok) {
            return err(describe(key.error));
        }
        const secret = key.value.secretAccessKey;
        return secret === undefined || secret === null
            ? err('Garage did not show the control plane key\'s secret')
            : ok({ accessKeyId: key.value.accessKeyId, secretAccessKey: secret });
    };

    /** Deletes every object in the bucket with the control plane's key; returns how many. */
    const emptyBucket = async (bucketId: string): Promise<Result<number, string>> => {
        const key = await controlPlaneKey();
        if (!key.ok) {
            return key;
        }
        const allowed = await call('POST', '/v2/AllowBucketKey', anything, {
            bucketId,
            accessKeyId: key.value.accessKeyId,
            permissions: { read: true, write: true, owner: false },
        });
        if (!allowed.ok) {
            return err(describe(allowed.error));
        }
        const client = new S3Client({
            endpoint: config.s3Url,
            region: GARAGE_REGION,
            forcePathStyle: true,
            credentials: key.value,
            requestChecksumCalculation: 'WHEN_REQUIRED',
        });
        // Garage addresses a bucket by its id too, so a renamed or unaliased one is still found.
        const emptied = await deleteAllObjects(client, bucketId);
        client.destroy();
        return emptied;
    };

    return {
        createBucket: async (name) => {
            const bucket = await call('POST', '/v2/CreateBucket', bucketSchema, { globalAlias: name });
            if (!bucket.ok) {
                return err(
                    typeof bucket.error !== 'string' && bucket.error.status === 409
                        ? { kind: 'name-taken' }
                        : { kind: 'unavailable', reason: describe(bucket.error) },
                );
            }
            const bucketId = bucket.value.id;
            // Undo what was created, so the name is free again; the bucket is still empty.
            const undo = async (error: Refusal | string, accessKeyId?: string): Promise<Result<never, CreateBucketError>> => {
                if (accessKeyId !== undefined) {
                    await call('POST', `/v2/DeleteKey?id=${encodeURIComponent(accessKeyId)}`, anything);
                }
                await call('POST', `/v2/DeleteBucket?id=${encodeURIComponent(bucketId)}`, anything);
                return err({ kind: 'unavailable', reason: describe(error) });
            };
            const key = await call('POST', '/v2/CreateKey', keySchema, { name: `bucket-${name}`, neverExpires: true });
            if (!key.ok) {
                return undo(key.error);
            }
            const { accessKeyId } = key.value;
            const allowed = await call('POST', '/v2/AllowBucketKey', anything, {
                bucketId,
                accessKeyId,
                permissions: { read: true, write: true, owner: false },
            });
            return allowed.ok ? ok({ bucketId, accessKeyId }) : undo(allowed.error, accessKeyId);
        },
        secretOf: async (accessKeyId) => {
            const key = await call('GET', `/v2/GetKeyInfo?id=${encodeURIComponent(accessKeyId)}&showSecretKey=true`, keySchema);
            if (!key.ok) {
                return err(describe(key.error));
            }
            const secret = key.value.secretAccessKey;
            return secret === undefined || secret === null ? err(`Garage did not show the secret of ${accessKeyId}`) : ok(secret);
        },
        setWebsite: async (bucketId, website) => {
            const websiteAccess =
                website === undefined
                    ? { enabled: false }
                    : {
                          enabled: true,
                          indexDocument: INDEX_DOCUMENT,
                          routingRules: website.spaFallback
                              ? [
                                    {
                                        Condition: { HttpErrorCodeReturnedEquals: 404 },
                                        Redirect: { ReplaceKeyWith: INDEX_DOCUMENT, HttpRedirectCode: 200 },
                                    },
                                ]
                              : [],
                      };
            const updated = await call('POST', `/v2/UpdateBucket?id=${encodeURIComponent(bucketId)}`, anything, { websiteAccess });
            return updated.ok ? ok(undefined) : err(describe(updated.error));
        },
        deleteKey: (accessKeyId) => deleteKey(accessKeyId),
        deleteBucket: async ({ bucketId, accessKeyId }) => {
            const keyDeleted = await deleteKey(accessKeyId);
            if (!keyDeleted.ok) {
                return keyDeleted;
            }
            const info = await call('GET', `/v2/GetBucketInfo?id=${encodeURIComponent(bucketId)}`, bucketSchema);
            if (!info.ok) {
                return isGone(info.error) ? ok(0) : err(describe(info.error));
            }
            const emptied = await emptyBucket(bucketId);
            if (!emptied.ok) {
                return emptied;
            }
            const uploads = await call('POST', '/v2/CleanupIncompleteUploads', anything, { bucketId, olderThanSecs: 0 });
            if (!uploads.ok) {
                return err(describe(uploads.error));
            }
            const deleted = await call('POST', `/v2/DeleteBucket?id=${encodeURIComponent(bucketId)}`, anything);
            return deleted.ok || isGone(deleted.error) ? ok(emptied.value) : err(describe(deleted.error));
        },
    };
}
