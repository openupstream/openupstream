---
title: Static sites
description: Static sites served from Germany. A Bucket at your domain with automatic TLS, SPA fallback, compression and one command to deploy.
---

A static site is a Bucket served at a Domain. It is a feature of
[object storage](/object-storage/), not a product of its own, so a site's
files are stored in three sites like every object.

## What you get

- **One command to deploy.** `oup site deploy` makes the Bucket mirror a
  directory: it uploads what changed and deletes what is gone.
- **Automatic TLS**, on the Project's default hostname and on your own
  domains.
- **Any path prefix.** A site can be served at `/` or below a path such as
  `/docs`, next to a Service on the same domain.
- **SPA fallback.** A path without a file serves `index.html`, for
  single-page applications with client-side routing.
- **Cache headers and compression.** Files with a content hash in their
  name are cached for a year, `index.html` is never cached, and responses
  are compressed with gzip, brotli or zstd.

## What to know before you use it

- **No CDN.** The site is served from Germany. Put a CDN in front if you
  want a global edge.
- **No builds.** You build the site yourself, or in your CI, and deploy the
  result.
- **SPA fallback is a setting of the Bucket**, so every Route to one Bucket
  has the same.
- **A custom domain needs a CNAME**, so the apex of a domain (`example.com`
  without `www`) only works where your DNS provider can flatten a CNAME.

## Billing

Through object storage: storage and egress. There is no price per site.

## How to use it

```sh
oup site deploy dist --bucket my-site
```

The [Static sites guide](/docs/static-sites/) covers the Route, cache
headers and deploying from CI.
