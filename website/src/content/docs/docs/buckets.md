---
title: Buckets
description: Create an S3-compatible Bucket, read its endpoint and access key, and use it with any S3 client.
---

A Bucket is an S3-compatible container for objects, stored in three Sites.
What it offers and what it leaves out is on the
[Object storage product page](/object-storage/).

## Create

Create a Bucket on the dashboard's Project page, with `oup`:

```sh
oup bucket create acme-uploads
```

or through the API, here with the [SDK](/docs/reference/sdk/):

```ts
const bucket = await client.createBucket(projectId, { name: 'acme-uploads' });
if (bucket.ok) {
    console.log(bucket.value.access);
}
```

The name is a hostname label: 3 to 63 lowercase letters, digits and
hyphens, neither starting nor ending with a hyphen. It must not be taken by
any Bucket of any customer.

## Access

A Bucket comes with what an S3 client needs:

| Field | Value |
| --- | --- |
| `endpoint` | `https://<name>.s3.openupstream.app` |
| `region` | `garage` |
| `accessKeyId`, `secretAccessKey` | a key that reads and writes this Bucket and no other |

`getBucket` returns them again at any time. The dashboard shows the
endpoint and never the key. `oup` hands the key out in two ways:

```sh
oup bucket export-env acme-uploads   # writes the variables into .env, without showing the secret
oup bucket show-access-key acme-uploads   # prints the key's id and its secret
```

`export-env` writes `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_REGION`, `AWS_DEFAULT_REGION`, `AWS_ENDPOINT_URL_S3` and `BUCKET_NAME`,
of which recent AWS SDKs read all but `BUCKET_NAME` by themselves. The AWS
CLI also needs
`aws configure set default.s3.addressing_style virtual`.

An API key that may only read gets the key's id and not its secret, since
the Bucket's key may write.

The Bucket is in the hostname (virtual-hosted style); path-style requests
are not served. Most S3 clients put the Bucket's name in front of the
endpoint themselves, so they take the endpoint without it:

```ts
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({
    endpoint: 'https://s3.openupstream.app',
    region: 'garage',
    credentials: { accessKeyId, secretAccessKey },
});
await s3.send(new PutObjectCommand({ Bucket: 'acme-uploads', Key: 'hello.txt', Body: 'hello' }));
```

A Service reaches its Project's Buckets at the same public hostname.
Unlike a Database's URL, a Bucket's key is not put into the environment:
store the endpoint and the key as [Secrets](/docs/secrets/) to hand them
to your containers.

## Limits

- A single request has to finish within 60 seconds. Upload large files in
  parts, which S3 clients do by default.
- There are no event notifications.

## Delete

Deleting a Bucket deletes every object in it, and nothing is kept. A Bucket
that a Route still serves cannot be deleted; delete the Route first.
