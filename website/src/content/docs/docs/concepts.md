---
title: Accounts, Projects and Sites
description: How Accounts, Members, Projects and Resources belong together, where openupstream runs and what happens when a site fails.
---

## Accounts and Members

An **Account** is the customer: the party that pays and gets one invoice.
Its **Members** are the people who sign in and act on its Projects. Each
has a role, or none:

- an **owner** may do everything, including who else is a Member and
  with which role. An Account always keeps at least one owner.
- a **developer** may do everything in every Project, but not change the
  Account's Members.
- a Member **without a role** uses only what their **grants** give: a
  grant lets them use one Database at `read`, `write` or `owner` level.
  They see that Database and its Project's name and connect with
  `oup pg proxy` at that level or below, and nothing else of the Project.
  Good for an analyst or a BI tool that reads one Database.

`oup member` lists the Members, changes their roles and grants and
removes them;
anyone may leave an Account. A removed Member loses their Postgres roles
in the Account's Databases within about a minute. If they had a
connection open at `owner` level, every `oup pg proxy` connection to that
Project's Databases is closed once, so tools reconnect within seconds.
Deleting your sign-in removes you from every Account in the same way,
and revoking an API key drops the Postgres roles it had.

An Account can have a **Hold**: a reason it may not create Resources now,
such as a missing payment method. Its existing Resources keep running.

## Projects and Resources

A **Project** is the unit of isolation and lifecycle. Staging and
production are separate Projects.

- Every **Resource** (a Database, a Bucket, a Service or a Job) belongs to
  exactly one Project.
- Deleting a Project deletes everything in it: Resources, Secrets and
  Domains.
- Projects cannot reach each other on the network, also not two Projects
  of one Account. They talk through their public Routes.
- A Project's Services and Jobs reach its Databases directly, and get
  their URLs and the Project's Secrets as environment variables.

## Sites

A **Site** is one location of one hosting provider, treated as one unit
that can fail. openupstream runs in three, all in Germany:

| Site | Location | Runs |
| --- | --- | --- |
| `hetzner-fsn1` | Falkenstein | Databases, Services, Jobs, a copy of every object |
| `ovh-lim` | Limburg, Frankfurt region | Databases, Services, Jobs, a copy of every object |
| third Site | Nuremberg | a copy of every object, and the deciding vote when the other two disagree |

A Database's **Home site** is where its primary runs when nothing has
failed, `hetzner-fsn1` unless you choose `ovh-lim`.

## When a Site fails

| Resource | What happens |
| --- | --- |
| Database | The standby in the other Site becomes the primary by itself. Writes pause for about 90 seconds. Writes of the last seconds before the failure can be missing. |
| Bucket | Reads and writes go on; two of three copies are enough. |
| Service with two or more replicas | The replicas in the other Site keep serving. |
| Service with one replica | It restarts in the other Site. |
| Your domains | DNS drops the failed Site's addresses after a health check fails. |

When the Site returns, a Database's old primary rejoins as the standby.
Moving the primary back to its Home site (**Failback**) is done
deliberately, not automatically, and pauses writes for about 15 seconds.

The figures were measured on a development cluster with a whole Site
switched off.
