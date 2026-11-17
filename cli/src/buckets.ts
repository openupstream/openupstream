/**
 * `oup bucket`: what an S3 client needs to reach a Bucket, as environment
 * variables, and a `.env` file that holds them next to whatever else is in
 * it. Pure, so it is tested without an API or a file.
 */
import type { BucketDetails } from '@openupstream/sdk';
import { type Result, err, ok } from './result.js';

/** A variable of an env file. */
export interface EnvEntry {
    readonly name: string;
    readonly value: string;
}

/**
 * The variables S3 clients read (the AWS CLI and SDKs take all but
 * `BUCKET_NAME` by themselves). The endpoint is the one above the Bucket's
 * own hostname: clients put the Bucket's name in front (virtual-hosted
 * style, the only one served). An error for a key that may not read the
 * secret.
 */
export const bucketEnv = (bucket: Pick<BucketDetails, 'name' | 'access'>): Result<readonly EnvEntry[], string> => {
    const { endpoint, region, accessKeyId, secretAccessKey } = bucket.access;
    return secretAccessKey === undefined
        ? err("this API key may not read the Bucket's key; it needs openupstream:write")
        : ok([
              { name: 'AWS_ACCESS_KEY_ID', value: accessKeyId },
              { name: 'AWS_SECRET_ACCESS_KEY', value: secretAccessKey },
              { name: 'AWS_REGION', value: region },
              { name: 'AWS_DEFAULT_REGION', value: region },
              { name: 'AWS_ENDPOINT_URL_S3', value: s3Endpoint(bucket.name, endpoint) },
              { name: 'BUCKET_NAME', value: bucket.name },
          ]);
};

/** `https://<bucket>.s3.<domain>` as `https://s3.<domain>`: what a client is given, which adds the Bucket's name itself. */
export const s3Endpoint = (name: string, endpoint: string): string => endpoint.replace(`//${name}.`, '//');

/** A value as an env file holds it: as it is when it has only plain characters, in single quotes otherwise. */
const quoted = (value: string): string => (/^[A-Za-z0-9_./:@%+=-]*$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);

const assigns = (line: string, name: string): boolean => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(line);

/**
 * The env file's text with the entries in it: a line that sets one of them
 * is replaced where it is (once; further ones go), the others are added at
 * the end, and every other line stays as it is.
 */
export const mergeEnv = (text: string, entries: readonly EnvEntry[]): string => {
    // The file's own line ending, for the lines it gets too.
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split(/\r?\n/);
    const kept = lines.flatMap((line, index) => {
        const entry = entries.find(({ name }) => assigns(line, name));
        return entry === undefined
            ? [line]
            : lines.findIndex((other) => assigns(other, entry.name)) === index
              ? [`${entry.name}=${quoted(entry.value)}`]
              : [];
    });
    const added = entries.filter(({ name }) => !lines.some((line) => assigns(line, name))).map(({ name, value }) => `${name}=${quoted(value)}`);
    return `${[...kept, ...added].join(eol)}${eol}`;
};

/** The Bucket a file's variables are for, when it has them: the value of its `BUCKET_NAME` line. */
export const bucketIn = (text: string): string | undefined =>
    text
        .split(/\r?\n/)
        .find((line) => assigns(line, 'BUCKET_NAME'))
        ?.replace(/^[^=]*=\s*/, '')
        .replace(/^(['"])(.*)\1$/, '$2')
        .trim();
