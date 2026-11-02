/** The files in a Bucket, over S3 with the Bucket's own key. */
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { FileInfo, FilesStore, StoredFile } from './files.js';

/** How the API shows a Bucket's access (BucketAccess in the SDK), copied into the Project's Secrets. */
export interface BucketAccess {
    readonly endpoint: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
}

/**
 * A client for the Bucket at `endpoint`, `https://<bucket>.s3.<domain>`.
 * Virtual-hosted style only: the client puts the name in front itself, so
 * it gets the endpoint without it, as `oup site deploy` does.
 */
export function bucketClient(access: BucketAccess): { readonly s3: S3Client; readonly bucket: string } {
    const url = new URL(access.endpoint);
    const [bucket = '', ...domain] = url.hostname.split('.');
    const endpoint = `${url.protocol}//${domain.join('.')}${url.port === '' ? '' : `:${url.port}`}`;
    const s3 = new S3Client({
        endpoint,
        region: access.region,
        credentials: { accessKeyId: access.accessKeyId, secretAccessKey: access.secretAccessKey },
        forcePathStyle: false,
        // Short timeouts: during a Site failure a request fails fast instead of holding the page.
        requestHandler: { connectionTimeout: 3000, requestTimeout: 10_000 },
        maxAttempts: 2,
    });
    return { s3, bucket };
}

/** The object, or undefined for a missing key. The SDK reports that only by throwing. */
async function getObject(s3: S3Client, bucket: string, key: string): Promise<StoredFile | undefined> {
    try {
        const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return { body: (await object.Body?.transformToByteArray()) ?? new Uint8Array(), contentType: object.ContentType ?? 'application/octet-stream' };
    } catch (error) {
        if (error instanceof Error && error.name === 'NoSuchKey') {
            return undefined;
        }
        throw error;
    }
}

export function bucketStore({ s3, bucket }: { readonly s3: S3Client; readonly bucket: string }): FilesStore {
    return {
        list: async (limit) => {
            const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: limit }));
            return Contents.map(
                (object): FileInfo => ({ name: object.Key ?? '', size: object.Size ?? 0, lastModified: (object.LastModified ?? new Date(0)).toISOString() }),
            );
        },
        get: (name) => getObject(s3, bucket, name),
        put: async (name, body, contentType) => {
            await s3.send(new PutObjectCommand({ Bucket: bucket, Key: name, Body: body, ContentType: contentType }));
            return { name, size: body.length, lastModified: new Date().toISOString() };
        },
        delete: async (name) => {
            await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: name }));
        },
        ping: () => s3.send(new HeadBucketCommand({ Bucket: bucket })).then(
            () => true,
            () => false,
        ),
    };
}
