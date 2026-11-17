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
| `--memory <MB>` | 256 | Memory of each instance. 256 MB is the smallest. |
| `--storage <GB>` | 1 | Size of each instance's volume. |
| `--site hetzner-fsn1\|ovh-lim` | `hetzner-fsn1` | The Home site. The standby runs in the other one. |
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
A Database is reachable from its own Project only. Access from your own
machine is planned as `oup pg proxy` and not built yet.

### Pooling

PgBouncer runs in transaction mode: a connection to Postgres is yours for
one transaction. Prepared statements work. What belongs to a session does
not: `LISTEN`, advisory locks and `SET`.

### After a failover

Connections to the old primary are dropped. Your application has to
connect again, which connection pools of most drivers do by themselves.

## Resize

```sh
oup pg resize main --memory 1024
oup pg resize main --storage 20
```

- **Storage** only grows. It grows online, without a restart.
- **Memory** restarts the standby, then the primary. Writes pause for
  seconds; plan for about two minutes in all.
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
