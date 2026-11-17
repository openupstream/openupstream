---
title: openupstream
description: Open source cloud infrastructure, hosted in the EU. Postgres, object storage, static sites and containers, running in three sites in Germany.
template: splash
hero:
  tagline: Open source cloud infrastructure, hosted in the EU. Postgres, object storage, static sites and containers, in three sites in Germany.
  actions:
    - text: Read the docs
      link: /docs/
      icon: right-arrow
    - text: Source on GitHub
      link: https://github.com/openupstream/openupstream
      icon: external
      variant: minimal
---

:::note[Status: pre-alpha]
The hosted service is not open for sign-up yet. These pages describe
version 1 as it is being built.
:::

## What you get

| Product | What it is | Billed by |
| --- | --- | --- |
| [Postgres](/postgres/) | One Postgres instance per Database, with a standby in a second site, automatic failover, backups with point-in-time recovery and pgvector | memory, CPU, storage |
| [Object storage](/object-storage/) | S3-compatible Buckets, every object stored in three sites | storage, egress |
| [Static sites](/static-sites/) | A Bucket served at your domain, with TLS and SPA fallback | through object storage |
| [Containers](/containers/) | Your image from any registry as a Service, a Cron job or a One-off job, sandboxed with gVisor | memory, CPU, egress |

Everything lives in a Project, for example one for staging and one for
production. One routing table per Project sends each domain and path to a
Bucket or a Service.

## Why openupstream

- **Your data stays in the EU.** Today everything runs in Germany, at three
  hosting providers: Falkenstein, the Frankfurt region and Nuremberg.
- **One site can fail.** Databases and Buckets keep working, and so do
  Services with two or more replicas. A Service with one replica restarts
  in the other site.
- **Open source.** The whole platform is in
  [one repository](https://github.com/openupstream/openupstream) under the
  AGPL. The hosted service runs exactly this code, and you can
  [run it yourself](/docs/self-hosting/).
- **Few parts.** Four products and one routing table, each documented with
  what it does and what it does not do.

## Not offered, on purpose

Queues, transactional mail, DNS, a CDN, stored logs, image builds and
databases that scale to zero are left out of version 1. The
[overview of the docs](/docs/#not-offered-on-purpose) says what to use in
their place.
