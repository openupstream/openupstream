---
title: Running it yourself
description: openupstream is open source under the AGPL. Where to find what you need to run the platform on your own servers.
---

The whole platform is in
[one repository](https://github.com/openupstream/openupstream) under the
AGPL-3.0. The hosted service runs exactly this code. You can run it
yourself, change it and offer it as a service; your changes then have to be
published under the same license.

## Where to look

- [Self-hosting](https://github.com/openupstream/openupstream/blob/main/docs/self-hosting.md):
  the tools, accounts, credentials and domains the platform needs.
- [Dev cluster](https://github.com/openupstream/openupstream/blob/main/infra/dev-cluster/README.md):
  installs the platform for development, on three cloud VMs or on a single
  machine of your own.
- [Architecture](https://github.com/openupstream/openupstream/blob/main/ARCHITECTURE.md):
  how it is built, and the reasoning behind each decision.
- [Scope](https://github.com/openupstream/openupstream/blob/main/docs/scope.md):
  what version 1 offers and what it leaves out.

## What differs on your own installation

- The dashboard, the API and sign-in are at your platform domain in place
  of `console.openupstream.com`. Sign in with `oup login --api
  https://<your platform domain>/api`, or set `OUP_API_URL`.
- Default hostnames and Buckets are under your customer domain in place of
  `openupstream.app`.
- Sign-up is open unless you close it.
- On a single machine there is one copy of everything: no standby, no
  failover and no second Site.
