/**
 * spa-api: a single-page app in one Bucket at `/` and this API, a Service
 * at `/api` on the same hostname, which keeps files in a second Bucket
 * (ARCHITECTURE.md, decision 30). The Bucket's access comes from the
 * Project's Secrets, copied there from what the API shows for the Bucket.
 */
import { createServer } from 'node:http';
import { log, portFromEnv } from '../shared/http.js';
import { filesHandler } from './files.js';
import { bucketClient, bucketStore } from './store.js';

const NAMES = ['BUCKET_ENDPOINT', 'BUCKET_REGION', 'BUCKET_ACCESS_KEY_ID', 'BUCKET_SECRET_ACCESS_KEY'] as const;
const missing = NAMES.filter((name) => (process.env[name] ?? '') === '');
if (missing.length > 0) {
    log({ msg: `${missing.join(', ')} not set: put the Bucket's access into the Project's Secrets` });
    process.exit(1);
}
const env = (name: (typeof NAMES)[number]): string => process.env[name] ?? '';
const client = bucketClient({
    endpoint: env('BUCKET_ENDPOINT'),
    region: env('BUCKET_REGION'),
    accessKeyId: env('BUCKET_ACCESS_KEY_ID'),
    secretAccessKey: env('BUCKET_SECRET_ACCESS_KEY'),
});

const server = createServer(filesHandler(bucketStore(client)));
server.listen(portFromEnv(), () => log({ msg: 'spa-api listening', port: portFromEnv(), bucket: client.bucket }));

process.on('SIGTERM', () => {
    log({ msg: 'stopping' });
    server.close(() => {
        client.s3.destroy();
        process.exit(0);
    });
});
