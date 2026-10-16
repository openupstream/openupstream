# Architecture

This document records the v1 design and the decisions behind it. It is the
source of truth until code exists that contradicts it; when that happens, fix
the document in the same change.

## Goals

- EU (German) hosting with a real geo-redundancy story: two datacenters,
  ~300 km apart, both in Germany.
- Utility pricing: customers pay for what they consume, per second and per
  GB-hour, not per plan.
- Open source: this repository is the product. Dependencies may be proprietary
  or source-available as long as they are free to use for running a hosted
  service.
- Operable by one person. Every component that can be borrowed from a mature
  project is borrowed; custom code is limited to the control plane.

## Non-goals (v1)

- Scale-to-zero databases. Postgres is always on with a 256 MB floor; idle
  tenants pay a small memory charge instead of eating a 5–15 s cold start.
- Synchronous multi-region writes (RPO 0). Replication is asynchronous; RPO is
  seconds, RTO is the failover time of CloudNativePG.
- Queues, mail, DNS, CDN, log analytics. See `docs/scope.md`.
- Own hardware. Everything runs on rented Hetzner dedicated servers.

## Components

```
                         ┌──────────────────────────────────────────┐
  customer ──HTTPS──▶    │ Traefik (ingress)  ◀── routing table     │
                         │   /api/* ──▶ tenant container (gVisor)   │
                         │   /*     ──▶ Garage bucket (static site) │
                         └──────────────────────────────────────────┘
                                          │
            ┌─────────────────────────────┼──────────────────────────┐
            ▼                             ▼                          ▼
   CloudNativePG cluster          Garage (S3)                control plane
   per tenant, FSN1 primary       replicated FSN1↔NBG1       API + operators
   NBG1 replica, PgBouncer        public buckets = sites     metering → OpenMeter → Stripe
   backups → Hetzner Object Storage (other site, client-side encrypted)
```

### Control plane (`control-plane/`)

Node.js/TypeScript API. Owns the data model: accounts, tenants, databases,
buckets, services, the routing table, secrets, API keys, usage events.
Provisioning is done by writing Kubernetes objects (CloudNativePG `Cluster`,
Traefik `IngressRoute`, Deployments/CronJobs/Jobs) and letting the operators
and controllers reconcile. State lives in its own Postgres on the cluster.

### Operators (`operators/`)

Thin reconcilers for the things no off-the-shelf operator does:

- routing table → Traefik `IngressRoute` + cert-manager `Certificate`
- static site → Garage bucket website config + ingress rule
- tenant lifecycle → CloudNativePG `Cluster` with replica cluster in NBG1,
  PgBouncer `Pooler`, backup schedule

### Tenant isolation

- Postgres: one instance per tenant in its own pod, own PVC, cgroup-limited.
  Isolation is kernel-level. The DB tier does not use gVisor because the image
  is ours and only the customer's SQL runs inside.
- Containers: customer images run under the `gvisor` RuntimeClass. Plain runc
  with untrusted images is not acceptable on shared nodes.
- Network: one Kubernetes namespace per tenant, default-deny NetworkPolicy,
  egress allowed, ingress only from Traefik.
- Jobs: "run this image once" is an API call; customers cannot spawn
  containers from inside containers.

### Metering and billing

Usage is emitted as events from day one, even while there is a single
customer: `cpu_seconds`, `memory_gb_hours`, `storage_gb_hours`, `egress_gb`,
keyed by tenant and resource. Source: cAdvisor/cgroup stats and PVC usage,
scraped by the control plane. Events go to OpenMeter; invoices come from
Stripe (SEPA enabled). Memory is billed at the configured limit, since it is
reserved; CPU is billed on actual consumption.

### Backups

CloudNativePG continuous WAL archiving plus scheduled base backups to a bucket
on Hetzner Object Storage in the site that does *not* host the primary.
Backups never live on the same Garage cluster that holds customer data.
Client-side encryption; retention long enough for a few weeks of PITR.

## Decisions

Short form here; longer ADRs go in `docs/decisions/`.

| # | Decision | Alternatives considered | Why |
| --- | --- | --- | --- |
| 1 | Hetzner dedicated servers, FSN1 + NBG1 | own hardware, Hetzner cloud VMs | RAM is the cost driver for always-on Postgres; dedicated RAM is 3–4× cheaper than cloud-VM RAM |
| 2 | k3s | Nomad, custom scheduler on Docker hosts | CloudNativePG, cert-manager, Traefik and the gVisor RuntimeClass assume Kubernetes; Postgres failover is the one place where borrowed, tested code matters most |
| 3 | Postgres via CloudNativePG, one instance per tenant | shared cluster with database-per-tenant, dedicated VM per tenant, YugabyteDB | per-tenant instance gives kernel-level isolation and per-tenant backup/version/extensions; shared cluster has no per-DB resource limits; Yugabyte is far heavier to run |
| 4 | Async streaming replication | synchronous multi-site | RPO of seconds is acceptable for the target customers; sync replication across 300 km costs every write |
| 5 | Garage for object storage | SeaweedFS, MinIO, reselling Hetzner Object Storage | built for small geo-distributed clusters; MinIO is AGPL and drifting; Hetzner's buckets are single-site and give no replication story |
| 6 | Traefik + cert-manager | Caddy outside the cluster | ships with k3s, routing table maps directly onto IngressRoute CRDs, one proxy instead of two |
| 7 | OpenMeter + Stripe | Lago, own rating engine | OpenMeter is built for event-stream metering; Stripe handles SEPA and invoicing; no reason to write a rating engine |
| 8 | No queue product | SQS-like service | `SKIP LOCKED` on the customer's Postgres covers the volume of the target customers and gives transactional enqueue for free |
| 9 | Static sites as a bucket feature | separate product, dropping it | avoids CORS for every SPA+API customer; it is a Caddy/Traefik rule on top of storage that exists anyway |
| 10 | CockroachDB, Nomad for DB, Redis, Elastic excluded | — | their licenses forbid offering them as a managed service |
| 11 | AGPL-3.0-only | Apache-2.0 | the business is running this code as a service; AGPL keeps a larger hoster from doing the same without contributing back |

## Build order

1. Postgres (CloudNativePG, replica cluster, PgBouncer, backups)
2. Object storage + static sites (Garage, routing table, Traefik, cert-manager)
3. Containers, HTTP service mode
4. Containers, cron and one-off job modes
5. Cutover of ProjectMatch, which exercises all of the above

The routing table schema and the secrets store are designed first because
every product hangs off them. Metering events are emitted from the first
deployment.
