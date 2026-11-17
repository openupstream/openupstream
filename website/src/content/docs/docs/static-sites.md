---
title: Static sites
description: Serve a Bucket at a Domain, deploy a directory with oup site deploy, and understand the cache headers and the SPA fallback.
---

A static site is a Bucket with a Route. What it offers and what it leaves
out is on the [Static sites product page](/static-sites/).

## Serve a Bucket

Create a [Bucket](/docs/buckets/), then a Route on one of the Project's
[Domains](/docs/domains/) that points at it:

```ts
await client.createRoute(projectId, domainId, {
    pathPrefix: '/',
    bucketId,
    spaFallback: true,
});
```

- The Route makes the Bucket's objects public at that Domain. The Bucket's
  S3 API still needs its key.
- A directory serves its `index.html`.
- The path prefix is stripped: on a Route at `/docs`, the request
  `/docs/guide.html` serves the object `guide.html`. One built site can so
  be mounted at any prefix.
- With `spaFallback`, a path without an object serves `index.html` with
  status 200. The setting belongs to the Bucket, so every Route to one
  Bucket has to agree.

## Deploy

```sh
oup site deploy dist --bucket my-site
```

The command makes the Bucket mirror the directory:

1. It uploads the files that differ from what the Bucket has.
2. It uploads every `index.html` last, so a visitor who loads the new page
   finds the assets it names.
3. It deletes the objects the directory no longer has.

| Flag | Meaning |
| --- | --- |
| `--keep` | Do not delete objects that are gone from the directory. |
| `--force` | Upload every file, which also rewrites the headers of objects another S3 client uploaded. |

Dotfiles are left out, except `.well-known`.

## Cache headers

`oup site deploy` sets `Cache-Control` from each file's name:

| File | Header |
| --- | --- |
| a content hash in its name, such as `app.3f9a2c1b.js` | `max-age=31536000, immutable` |
| `index.html` | `no-cache` |
| everything else | `max-age=300` |

Files uploaded with another S3 client keep the headers that client set.

## Deploy from CI

Set `OUP_API_KEY` to an API key and `OUP_PROJECT` to the Project, then run
the same command:

```sh
npm run build
oup site deploy dist --bucket my-site
```
