---
title: Databases
description: Create a Postgres Database, connect to it from Services and Jobs, resize it, let its storage grow, and restore it to a point in time.
---

A Database is one Postgres instance with a primary in its Home site and a
standby in the other compute Site. What it offers and what it leaves out is
on the [Postgres product page](/postgres/).

## Create

```sh
oup pg create main --memory 512 --storage 10
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--memory <MB>` | 256 | Memory of each instance. It also sets the CPU each instance is guaranteed: a quarter core per GB. 256 MB is the smallest. |
| `--storage <GB>` | 1 | Size of each instance's volume. |
| `--site <site>` | the default Site | The Home site, one of `oup sites`. The standby runs in another one. |
| `--max-storage <GB>` | none | How far storage may grow by itself. |
| `--no-auto-grow` | | Storage only changes when you resize it. |
| `--no-wait` | | Return before the instances are ready. |

A create is refused when the Sites lack the room for the size you asked
for, instead of leaving a Database that never starts.

## Connect

Every Service and Job of the Project gets a URL per Database in its
environment:

- `DATABASE_URL_<NAME>`, with the Database's name in upper case and `-` as
  `_`, for example `DATABASE_URL_MAIN`
- `DATABASE_URL`, for the Project's oldest Database

These variables win over a Secret of the same name. When a Database is
added or deleted, the Project's Services restart to get the new variables.

The URL points at PgBouncer, which follows the primary through a failover.
From outside the Project, a Database is reachable only from your own
machine, with `oup pg proxy` (below).

### Pooling

PgBouncer runs in transaction mode: a connection to Postgres is yours for
one transaction. Prepared statements work. What belongs to a session does
not: `LISTEN`, advisory locks and `SET`.

### After a failover

Connections to the old primary are dropped. Your application has to
connect again, which connection pools of most drivers do by themselves.

## From your own machine

```sh
oup pg proxy main
oup pg proxy main --access owner --port 5433
```

While it runs, `oup pg proxy` listens on `127.0.0.1:5432` and prints the
URL to give `psql`, a database GUI or a migration tool. Each connection
travels through a WebSocket on port 443, opened with your sign-in, so
nothing needs installing or opening besides `oup`.

You log in with a Postgres role of your own, created the first time you
ask for it; that first start waits a minute or two. The same role and
password come back every time, on any machine. `--access` picks what it
may do:

- `read`, the default: read every table
- `write`: also insert, update and delete rows, not change the schema
- `owner`: act as `app`, the role your Services use, so migrations work
  and the tables they create belong to `app`

`read` and `write` go through PgBouncer, like a Service. `owner` goes to
the primary, so migration tools that take an advisory lock work; it
allows 5 connections at once, which end when the primary restarts or
fails over. Owners and developers may pick any level. When a Member leaves
or is removed, their roles, and those of their API keys, are dropped.

In CI, `OUP_API_KEY` works too, with an Account token or an API key (which
needs `openupstream:write`). Either gets roles of its own, dropped when you
revoke it. For a BI tool, an Account token with a `read` grant on one
Database is enough: `oup token create metabase --expires 365d`, then
`oup token grant metabase read --database main`.

## Resize

```sh
oup pg resize main --memory 1024
oup pg resize main --storage 20
```

- **Storage** only grows. It grows online, without a restart.
- **More memory** needs no restart: both instances get it while they
  run, connections stay open, and the guaranteed CPU grows with it, a
  quarter core per GB. Postgres's `shared_buffers` keeps its size until
  the next restart; until then the added memory is used as the operating
  system's file cache.
- **Less memory** restarts the standby, then the primary. Writes pause for
  seconds; plan for about a minute in all.
- The Database reads `resizing` until both instances have the new size.

## Storage that grows by itself

Once the fuller of the two volumes is 90% used, storage grows by half, at
least by 1 GB. It is on by default and has no limit unless you set one:

```sh
oup pg resize main --max-storage 40
oup pg resize main --no-auto-grow
```

Storage does not grow while the Account has a Hold, or when it has reached
its maximum. A Database whose volume fills up stops accepting writes until
it has room again.

## Restore

A restore creates a new Database that starts as a copy of another one at a
moment you choose. The source keeps running.

```sh
oup pg restore main main-restored --time 2026-11-10T09:30:00Z
```

- Without `--time`, the new Database starts at the latest point the backups
  reach.
- The time has to lie after the source's oldest backup and at least 5
  minutes in the past.
- A deleted Database is restored by its id, which `oup pg delete` prints,
  within the backup retention window of a few weeks.
- Point your application at the new Database, with its own
  `DATABASE_URL_<NAME>`, once it looks right.

Backups are kept in a third location that runs neither instance of the
Database.

## Delete

```sh
oup pg delete main
```

The Database is gone at once. Its backups are kept for the retention
window, so it can still be restored into a new Database.

## Extensions

pgvector is enabled in every Database.
