---
title: Postgres
description: Managed Postgres hosted in Germany. One instance per Database with a standby in a second site, automatic failover, point-in-time recovery and pgvector.
---

A Database is one Postgres instance of your own, running in two sites. The
primary runs in its Home site, Falkenstein by default, and a streaming
standby runs in the Frankfurt region.

## What you get

- **A standby in a second site.** Replication is asynchronous. When the
  primary's site fails, the standby takes over by itself.
- **Connection pooling.** Your Services connect through PgBouncer in
  transaction mode, which follows the primary through a failover.
- **Backups and point-in-time recovery.** Continuous backups go to a third
  location that runs neither instance. You restore to any moment within the
  retention window, into a new Database, also for a Database you deleted.
- **Resizing without a migration.** Memory and storage change through one
  command. Storage grows online, and by itself as the Database fills up,
  unless you turn that off or set a maximum.
- **pgvector** is enabled in every Database.
- **Always on.** A Database never sleeps, so the first query is as fast as
  the next. The smallest size is 256 MB of memory and 1 GB of storage.

## What to know before you use it

- **Writes are not synchronous across sites.** If a whole site fails, the
  last seconds of writes can be lost. In a failover test on a development
  cluster no acknowledged write was lost and writes were back after about
  90 seconds.
- **Session features need a direct connection.** `LISTEN`, advisory locks
  and `SET` do not work through transaction pooling.
- **A Database is reachable from its own Project**, its Services and Jobs,
  **and from your own machine with `oup pg proxy`**, through a tunnel on
  port 443. Nothing faces the internet on Postgres's port, so tools that
  cannot run `oup`, such as a hosted BI tool, cannot connect.
- **Storage only grows.** It cannot be made smaller again.
- **Changing memory restarts both instances** one after the other. Writes
  pause for seconds.
- **No scale to zero.** An idle Database costs its memory and storage.

## Billing

By memory (GB-hours of the configured size), CPU-seconds and storage
(GB-hours). The standby and the backups are included in the unit price.

## How to use it

```sh
oup pg create main --memory 512 --storage 10
```

Every Service and Job of the Project then finds the Database in
`DATABASE_URL`. The [Databases guide](/docs/databases/) covers connecting,
resizing, failover and restoring.
