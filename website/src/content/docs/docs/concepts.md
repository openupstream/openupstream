---
title: Accounts, Projects and Sites
description: How Accounts, Members, Projects and Resources belong together, where openupstream runs and what happens when a site fails.
---

## Accounts and Members

An **Account** is the customer: the party that pays and gets one invoice.
Its **Members** are the people who sign in and act on its Projects.

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
