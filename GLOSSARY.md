# Glossary

The domain language of openupstream: what customers buy and how the platform
is laid out. Terms only; how each thing is built is in `ARCHITECTURE.md`.

## Customers and ownership

**Account**:
The customer: the party that pays and receives one invoice, and whose
members sign in. Owns one or more Projects.
_Avoid_: tenant, organization, subscription, customer (in code)

**Member**:
A person who can sign in to an Account and act on its Projects.
_Avoid_: user (ambiguous with the customer's own users)

**Hold**:
A reason an Account may not create Resources now, such as a missing
payment method. An Account without Holds may; its existing Resources keep
running either way.
_Avoid_: block, lock, suspension (suspending Resources is something else)

**Project**:
The unit of isolation and lifecycle inside an Account. Every Resource
belongs to exactly one Project; deleting a Project deletes everything in it.
Staging and production are separate Projects.
_Avoid_: tenant, environment, resource group, namespace

**Resource**:
Anything billable that a Project contains: a Database, a Bucket or a
Service.

## Products

**Database**:
One Postgres instance owned by a Project, running in two Sites.
_Avoid_: cluster, instance (both are implementation words)

**Bucket**:
An S3-compatible container for objects, owned by a Project.

**Static site**:
A public Bucket served at a Domain. A feature of a Bucket, not a Resource
of its own.
_Avoid_: website, hosting

**Service**:
A customer container image running continuously as an HTTP service, with
one or more replicas.
_Avoid_: app, deployment, function

**Cron job**:
A customer container image started on a schedule and run to completion.

**One-off job**:
A customer container image started once through the API and run to
completion.
_Avoid_: task, run

**Secret**:
A named value stored encrypted and handed to a Project's Services and jobs
as an environment variable.

## Routing

**Domain**:
A hostname that serves a Project's Routes. Either the Project's default
hostname under the platform's customer domain, or a custom domain whose
ownership the Account has proven.
_Avoid_: host, vhost

**Route**:
One entry under a Domain: everything below a path prefix goes to a Bucket or
a Service of the same Project.

**Routing table**:
All Routes of all Domains. A Domain appears in it at most once.
_Avoid_: route table, ingress

## Infrastructure

**Site**:
One datacenter location of one hosting provider that the platform runs in,
treated as a single failure domain. A compute Site runs Databases and
Services; the third Site only keeps quorum and a copy of object data.
_Avoid_: region, zone, datacenter

**Home site**:
The Site where a Database's primary runs when nothing has failed.

**Failover**:
Moving a Database's primary, or the public ingress, to another Site because
the current one stopped working. Automatic.

**Failback**:
Moving a Database's primary back to its Home site once that Site is healthy
again. Deliberate, not automatic.
_Avoid_: switchback

## Billing

**Usage event**:
A record that a Resource consumed a measured amount of one billable unit
over a time interval.

**Egress**:
Bytes the platform sends to the internet in HTTP responses for a Project's
Domains and Buckets. Traffic inside the platform and connections a Service
opens to the internet are not Egress.
