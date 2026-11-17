---
title: Documentation
description: How to use openupstream. Guides for Databases, Buckets, static sites, Services, Jobs, Domains and Secrets, and the reference for oup and the SDK.
---

These pages say how to use openupstream. What each product is, and what to
know before you choose it, is on the product pages:
[Postgres](/postgres/), [Object storage](/object-storage/),
[Static sites](/static-sites/) and [Containers](/containers/).

:::note[Status: pre-alpha]
The hosted service is not open for sign-up yet. The docs describe
version 1 as it is being built, and say where something is planned and not
built.
:::

## Where to start

- [Getting started](/docs/getting-started/): from signing in to a running
  Service with a Database.
- [Accounts, Projects and Sites](/docs/concepts/): how things belong
  together, and what happens when a site fails.

## Three ways to work

- **`oup`**, the command line tool, for your terminal and your CI. See the
  [reference](/docs/reference/cli/).
- **The dashboard**, at `console.openupstream.com` for the hosted service.
- **The API**, through the [TypeScript SDK](/docs/reference/sdk/). `oup` and
  the dashboard are built on it, so everything they do, you can script.

## Not offered, on purpose

- **Queues.** Use `SELECT … FOR UPDATE SKIP LOCKED` on your Postgres;
  pg-boss and Graphile Worker package the pattern. You get transactional
  enqueue and one service less to depend on. A Service without a port is
  the worker.
- **Transactional mail.** Use SES, Resend, Scaleway TEM or similar.
- **DNS and a CDN.** Point your DNS at openupstream; put a CDN in front if
  you want a global edge. Ingress is in Germany.
- **Stored logs and alerting.** There is a [live log stream](/docs/logs/),
  and nothing is kept.
- **Building images.** Bring a built image from any registry.
- **Databases that scale to zero.** A Database is always on.
- **Synchronous writes across sites.** After the loss of a whole site, the
  last seconds of writes can be missing.
