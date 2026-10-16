# Architecture

This document records the v1 design and the decisions behind it. It is the
source of truth until code exists that contradicts it; when that happens, fix
the document in the same change. Domain terms (Account, Project, Site, …) are
defined in [GLOSSARY.md](GLOSSARY.md).

## Goals

- EU hosting with a real geo-redundancy story: customer data stays in the EU,
  and the loss of any one Site, or of any one hosting provider, does not stop
  the platform. Today all three Sites are in Germany.
- Utility pricing: customers pay for what they consume, per second and per
  GB-hour, not per plan.
- Open source: this repository is the product. Dependencies may be proprietary
  or source-available as long as they are free to use for running a hosted
  service.
- Operable by one person. Every component that can be borrowed from a mature
  project is borrowed; custom code is limited to the control plane and thin
  operators.

## Non-goals (v1)

- Scale-to-zero databases. Postgres is always on with a 256 MB floor; idle
  Databases pay a small memory charge instead of eating a 5–15 s cold start.
- Synchronous multi-site writes (RPO 0). Replication is asynchronous; RPO is
  seconds, RTO is the failover time of CloudNativePG.
- Queues, mail, DNS, CDN, log analytics. See `docs/scope.md`.
- Own hardware. Everything runs on rented servers (Hetzner, OVHcloud, netcup).
- Building images from source. Customers bring a built image.

## Components

```
                         ┌──────────────────────────────────────────┐
  customer ──HTTPS──▶    │ Traefik (ingress)  ◀── routing table     │
                         │   /api/* ──▶ Service (gVisor)            │
                         │   /*     ──▶ Garage bucket (static site) │
                         └──────────────────────────────────────────┘
                                          │
            ┌─────────────────────────────┼──────────────────────────┐
            ▼                             ▼                          ▼
   CloudNativePG Cluster          Garage (S3), rf=3          control plane
   per Database, primary in       one zone per Site          API + operators
   Home site, standby in the      public buckets = sites     usage events → Stripe
   other compute Site, PgBouncer
   backups → Hetzner Object Storage NBG1 (a location that runs no Database)
```

## Sites and failure handling

One k3s cluster spans three Sites, each at a different provider
([ADR-0002](docs/adr/0002-three-sites.md)):

| Site | Provider, location | Runs | Role |
| --- | --- | --- | --- |
| `hetzner-fsn1` | Hetzner, Falkenstein | k3s server (etcd), Databases, Services, Traefik, Garage zone | compute Site, default Home site |
| `ovh-lim` | OVHcloud, Limburg (Frankfurt region) | k3s server (etcd), Databases, Services, Traefik, Garage zone | compute Site |
| `netcup-nbg` | netcup, Nuremberg | k3s server (etcd), Garage zone; no Databases or Services | third vote for etcd and third copy for Garage |

The compute Sites are about 300 km and 6 ms round-trip apart; the third Site
is about 3 ms from `hetzner-fsn1` (measured 2026-10-16). etcd heartbeat and
election timeouts are set from the measured round-trip time, not left at the
defaults.

When any one Site fails, or its whole provider does:

- etcd keeps quorum (2 of 3), so the Kubernetes API and every operator keep
  working.
- CloudNativePG promotes the standby of every Database whose primary was in
  the failed Site. Writes continue after the failover; up to a few seconds of
  writes can be lost (async replication).
- Garage keeps read and write quorum (2 of 3 copies).
- Services from the failed compute Site are rescheduled into the other one.
  Each compute Site keeps enough free capacity to run every Service of the
  other.
- The DNS health checks drop the failed Site from the ingress records (see
  Ingress and failover).

Customer data location: Databases are in Falkenstein and Limburg, Bucket
contents in all three Sites, backups in Hetzner's Nuremberg location. All in
Germany.

### Node network and admin access

- There is no private network across providers. Nodes talk over their public
  IPs with flannel's `wireguard-native` backend (MTU 1420), so all pod traffic
  between Sites is encrypted. NetworkPolicy is enforced by k3s's built-in
  controller.
- A host firewall on every node allows WireGuard, 80/443 and Tailscale from
  the internet, and the node-to-node ports (k3s API 6443, etcd 2379–2380,
  kubelet 10250, Garage RPC 3901) only from the other two nodes' public IPs.
  These control-plane connections are TLS (k3s, etcd) or Garage's own
  encrypted RPC; flannel's WireGuard carries pod traffic only.
- gVisor (`runsc`) is added by hand to k3s's containerd config template and
  exposed as the `gvisor` RuntimeClass; k3s does not detect it on its own.
- Tailscale is for admin access only (Kubernetes API, SSH, Grafana). It is
  not the node mesh.

### Ingress and failover

- Traefik serves traffic in both compute Sites at the same time
  (active-active). Either one routes to Services and Buckets in either Site.
- `ingress.<customer domain>` has A and AAAA records for both compute Sites,
  TTL 60 s. Custom domains CNAME to it. An apex domain cannot be a CNAME, and
  A/AAAA records copied into the customer's zone would never drop a failed
  Site, so apex domains need CNAME flattening (ALIAS/ANAME) at the customer's
  DNS provider, or a `www` Domain with the apex redirecting to it.
- bunny.net DNS health-checks both Sites over HTTP every 30 s from three
  regions and drops a failed Site's records. The checks run outside our
  Sites and do not depend on any hosting provider's API.
- What clients see when a compute Site fails: if the Site refuses
  connections, clients move to the other address within milliseconds. If it
  goes dark, Safari, iOS and Node move within about 2 s; Chrome and Firefox
  users whose first address was the dead one wait until the record is
  dropped and their DNS cache expires, about 2–3 minutes at worst. A Site
  that accepts connections but is broken is covered only by the health
  check (about 1–2.5 minutes). Plain Java `HttpClient` does not fail over
  until DNS changes.

## Control plane (`control-plane/`)

Node.js/TypeScript API. Owns the data model: Accounts, Members, Projects,
Databases, Buckets, Services, jobs, the routing table, Secrets, API keys and
usage events. Provisioning is done by writing Kubernetes objects
(CloudNativePG `Cluster`, Traefik `IngressRoute`, Deployments, CronJobs, Jobs)
and letting the operators and controllers reconcile. State lives in its own
Database on the cluster, provisioned the same way as a customer's.

The schema is plain SQL migrations in `control-plane/migrations`, applied with
node-pg-migrate; queries go through `pg` (node-postgres). The schema enforces
the data model's invariants itself: a hostname is routed for at most one
Domain, Routes only target Resources of their Domain's Project, deleting a
Project cascades to everything in it, an Account with Projects cannot be
deleted, and usage events are append-only. Its tests run against a real
Postgres in Docker. The API types are in `sdk/src/model.ts`.

The dashboard (`dashboard/`) is a Next.js app on the same API.

Sign-in for Members and API keys for `oup` and the SDK come from
[madAuth](https://madauth.com), self-hosted on the cluster.

## Operators (`operators/`)

Thin reconcilers for the things no off-the-shelf operator does:

- routing table → Traefik `IngressRoute` + cert-manager `Certificate`
- static site → Garage bucket website config and routing rules
- Database → CloudNativePG `Cluster` (two instances, one per compute Site),
  PgBouncer `Pooler`, backup schedule
- Secrets → a Kubernetes `Secret` in the Project's namespace

## Products

### Postgres

- One CloudNativePG `Cluster` per Database, two instances: the primary in the
  Database's Home site (`hetzner-fsn1` by default), a streaming standby in
  the other compute Site. Required pod anti-affinity on
  `topology.kubernetes.io/zone`, where each Site is one zone.
- The third Site's node carries a `NoSchedule` taint, and Databases and
  Services have required node affinity to compute Sites, so nothing customer
  facing ever lands on it, even when a compute Site is full or down.
- Failover is automatic inside the one k3s cluster. CloudNativePG's primary
  isolation check (on by default) shuts down a primary that can reach neither
  the API server nor its standby. There is no CloudNativePG replica cluster.
- Failback is a declarative switchover back to the Home site once it is
  healthy, done from a runbook, not automatically.
- Storage is local NVMe through TopoLVM, which enforces the requested volume
  size and supports resizing.
- PgBouncer through a CloudNativePG `Pooler` of type `rw`, so it follows the
  primary.
- Always on, 256 MB memory floor, pgvector enabled. The image is ours
  (`images/postgres`), so the DB tier does not run under gVisor; only the
  customer's SQL runs inside.

### Object storage

- Garage with replication factor 3, one zone per Site, `consistent` mode.
  Every object is stored once in each Site.
- Keys and buckets are managed by the control plane through Garage's admin
  API.
- The S3 API is served through Traefik, virtual-hosted style only
  (`<bucket>.s3.<customer domain>`), so every request is attributable to one
  Bucket for metering. Bucket names are hostnames, so they are unique across
  all Projects.
- No bucket event notifications (Garage does not implement them).

### Static sites

- A public Bucket served at a Domain through the routing table, using
  Garage's website endpoint behind Traefik.
- SPA fallback is a Garage routing rule: a 404 serves `index.html` with
  status 200.
- Cache headers are object metadata, set when `oup site deploy` uploads each
  file: files with a content hash in the name get
  `max-age=31536000, immutable`, `index.html` gets `no-cache`, everything else
  `max-age=300`. Files uploaded with another S3 client keep whatever headers
  that client set; ingress does not rewrite them.
- Compression (gzip, brotli, zstd) at Traefik. No CDN; customers who want one
  put Cloudflare in front.

### Containers

- The customer's image from any registry. Pull credentials are stored as a
  Secret and rendered as an `imagePullSecret`. Every deploy resolves the tag to
  a digest and pins it, so restarts and rescheduling run the same image. We do
  not run a registry.
- Three modes: Service (HTTP, 1..N replicas, no scale-to-zero), Cron job,
  One-off job (started through the API only).
- Under the `gvisor` RuntimeClass. Plain runc with untrusted images is not
  acceptable on shared nodes.
- Services with two or more replicas are spread across both compute Sites;
  single-replica Services run in the Home site of the Project's Databases.

## Routing and domains

- The routing table lives in the control plane: `Domain → [(path prefix →
  Bucket | Service)]`. A Domain belongs to exactly one Project and its Routes
  target only that Project's Buckets and Services, so ingress never crosses
  namespaces.
- Every Project gets a default hostname under a separate customer domain
  (for example `<project>.openupstream.app`; name to be chosen) that is on
  the Public Suffix List, so one Project's site cannot set cookies for
  another's. Bucket hostnames (`<bucket>.s3.…`) live there too.
  `openupstream.com` is only for our own dashboard, API and sign-in.
- Both zones are hosted on bunny.net DNS (see Ingress and failover).
- A custom domain is routed and gets a certificate only after the Account
  proves ownership with a TXT record at `_openupstream.<domain>`. A Domain
  appears in the routing table at most once; a new claim needs a new proof.
  A pending claim does not reserve the hostname: several Projects may claim
  it, the first to publish the proof gets it, so nobody can squat a hostname
  they do not own.
- A Route sends a path prefix (`/` or `/a/b`, no trailing slash) to a Bucket,
  optionally with SPA fallback, or to a Service. A Bucket or Service that a
  Route still targets cannot be deleted; deleting a Domain deletes its
  Routes.
- Traefik and cert-manager do ingress and TLS; certificates for custom
  domains use HTTP-01.

## Project isolation

- One Kubernetes namespace per Project, default-deny NetworkPolicy, also
  between Projects of the same Account. Ingress only from Traefik; Projects
  reach each other only through public Routes.
- Egress to the internet is allowed, with a per-pod bandwidth limit.
- One-off jobs are an API call; customers cannot spawn containers from inside
  containers.
- Deleting a Project deletes its namespace and every Resource, Secret and
  Domain in it. Its usage events are kept for billing. An Account can only be
  deleted once it has no Projects left.

## Secrets

- Stored in the control plane's Database, each value encrypted with a
  per-Project data key; data keys are wrapped by one key-encryption key.
  Both layers are AES-256-GCM. The associated data binds a wrapped data key
  to its Project and a value to its Project and name, so copying rows
  between Projects does not make them readable. Each wrapped data key
  records the id of its key-encryption key, so the key-encryption key can be
  rotated by rewrapping the data keys without touching the values.
- The key-encryption key is a Kubernetes Secret in the control plane's
  namespace; k3s secrets encryption at rest is on.
- The Secrets operator renders a Kubernetes `Secret` into the Project's
  namespace; Services and jobs read it via `envFrom`. Changing a Secret rolls
  the Services that use it.
- The envelope protects copies of the control plane's Database that leave the
  cluster (backups). It does not protect against someone with cluster-admin;
  that is accepted.

## Metering and billing

- Usage events are written from the first deployment on, even with a single
  customer, to an append-only table in the control plane's Database, keyed by
  Project and Resource. A trigger rejects updates, deletes and truncation.
  Events have no foreign keys and carry the Account: the last hours of a
  deleted Resource or Project are still billed.
- Units:
  - `cpu_seconds`: actual consumption, summed over all pods of a Resource
    (both Database instances, all replicas of a Service).
  - `memory_gb_hours`: the configured limit, counted once, since it is
    reserved.
  - `storage_gb_hours`: logical size, counted once: the volume size of a
    Database, the bytes stored in a Bucket.
  - `egress_gb`: Traefik's response bytes per router, mapped to the router's
    Project and Resource.
- Unit prices include the copies in the other Sites; the invoice shows what
  the customer configured or stored, not how many copies we keep.
- Connections a Service opens to the internet are not metered or billed
  (Open question 4).
- An hourly job rolls the events up and sends them to Stripe Billing Meters.
  Stripe rates, invoices (one per Account, broken down per Project) and
  collects (SEPA enabled).

## Backups

- CloudNativePG Barman Cloud Plugin: continuous WAL archiving plus scheduled
  base backups to a bucket on Hetzner Object Storage in Nuremberg (NBG1), a
  location that runs no instance of any Database. Backups are never in the
  same place as either instance, also after a failover.
- A separate Hetzner project with its own credentials, not the cluster's.
- Backups never live on the Garage cluster that holds customer data.
- Encryption is Hetzner's at rest. Barman Cloud has no client-side
  encryption; whether SSE-C works on Hetzner Object Storage is an open
  question.
- Retention covers a few weeks of point-in-time recovery.

## Observability and customer logs

- For us: Prometheus, Loki and Grafana. Loki collects the platform's
  namespaces only, never a Project's.
- For customers: a log stream endpoint that tails the Kubernetes logs API
  (current and previous container). Nothing is retained.

## Decisions

Short form here; longer ADRs go in `docs/adr/` and are linked from their row.

| # | Decision | Alternatives considered | Why |
| --- | --- | --- | --- |
| 1 | Dedicated servers for the compute Sites | own hardware, cloud VMs | RAM is the cost driver for always-on Postgres; dedicated RAM is about 3× cheaper than cloud-VM RAM (Hetzner CCX43, 64 GB: €276/month; a 64 GB dedicated server: €59–74). Before revenue: #33 |
| 2 | k3s | Nomad, custom scheduler on Docker hosts | CloudNativePG, cert-manager, Traefik and the gVisor RuntimeClass assume Kubernetes; Postgres failover is the one place where borrowed, tested code matters most |
| 3 | Postgres via CloudNativePG, one instance per Database | shared cluster with database-per-customer, dedicated VM per customer, YugabyteDB | a per-Database instance gives kernel-level isolation and per-Database backup/version/extensions; shared cluster has no per-DB resource limits; Yugabyte is far heavier to run |
| 4 | Async streaming replication | synchronous multi-site | RPO of seconds is acceptable for the target customers; sync replication across 300 km costs every write |
| 5 | Garage for object storage | SeaweedFS, MinIO, reselling Hetzner Object Storage | built for small geo-distributed clusters; MinIO is AGPL and drifting; Hetzner's buckets are single-site and give no replication story |
| 6 | Traefik + cert-manager | Caddy outside the cluster | ships with k3s, routing table maps directly onto IngressRoute CRDs, one proxy instead of two |
| 7 | ~~OpenMeter + Stripe~~, superseded by #18 | Lago, own rating engine | — |
| 8 | No queue product | SQS-like service | `SKIP LOCKED` on the customer's Postgres covers the volume of the target customers and gives transactional enqueue for free |
| 9 | Static sites as a bucket feature | separate product, dropping it | avoids CORS for every SPA+API customer; it is a routing rule on top of storage that exists anyway |
| 10 | CockroachDB, Nomad for DB, Redis, Elastic excluded | — | their licenses forbid offering them as a managed service |
| 11 | AGPL-3.0-only ([ADR-0001](docs/adr/0001-agpl-license.md)) | Apache-2.0 | the business is running this code as a service; AGPL keeps a larger hoster from doing the same without contributing back |
| 12 | Self-managed k3s, no managed Kubernetes | Hetzner managed Kubernetes, Cloudfleet, Syself | Hetzner sells no managed Kubernetes (checked 2026-10-16); third-party control planes add a subprocessor and still leave us the nodes, gVisor and storage |
| 13 | Account → Project → Resources; "tenant" is not a domain term | Account as the isolation unit; environments inside a Project | a Project is the isolation and lifecycle unit (namespace, delete-all), like an Azure resource group; staging and prod are separate Projects |
| 14 | Custom domains need a TXT ownership proof; every Project gets a default hostname | trust the first claim | the routing table is keyed by Domain; without a proof one Account could take another's hostname and certificate |
| 15 | Images from any registry with a pull secret, pinned by digest; no own registry | run a registry, build from source | least to operate; digest pinning makes restarts and failover reschedules run the same image. A registry outage during a Site failure can block restarts (Open question 5) |
| 16 | Egress = HTTP response bytes through Traefik; Service-initiated connections not billed | per-pod byte accounting in the CNI | Traefik already exports per-router byte counters; no CNI gives per-pod internet bytes out of the box, and traffic on the Hetzner and OVH dedicated servers is unmetered |
| 17 | Replicated resources metered in logical units, counted once | bill per copy | the customer sees what they configured or stored; unit prices cover the copies |
| 18 | Usage events in the control plane's Database, hourly rollups to Stripe Billing Meters | OpenMeter self-hosted, OpenMeter Cloud, Lago | self-hosted OpenMeter needs Kafka and ClickHouse, too much for one operator; Stripe already rates and invoices |
| 19 | Each compute Site keeps capacity for every Service of the other | best-effort rescheduling | the product claims geo-redundancy; Database standbys already reserve their RAM |
| 20 | Secrets: envelope encryption in the control plane's Database, rendered into Kubernetes Secrets | OpenBao/Vault | protects backups of the control plane's Database; Vault is too heavy for one operator; cluster-admin compromise is out of scope |
| 21 | Customer logs are a live tail only, nothing retained | Loki with per-Project retention | no customer log data (often personal data) to store, secure and list in the TOMs |
| 22 | madAuth for Member sign-in and API keys | own auth code, Auth0/Cognito | already built (passkeys, OAuth, scoped API keys), self-hosted, no extra subprocessor |
| 23 | Static-site cache headers set at upload; SPA fallback via a Garage routing rule | rewrite headers in Traefik, Traefik errors middleware | Garage only serves per-object `Cache-Control`; its v2 routing rules return `index.html` with status 200, the errors middleware keeps the 404 |
| 24 | Three Sites at three providers: compute at Hetzner Falkenstein and OVHcloud Limburg, third Site (etcd + Garage only) at netcup Nuremberg ([ADR-0002](docs/adr/0002-three-sites.md)) | Hetzner FSN1 + NBG1 + HEL1; OVH Limburg + Strasbourg; two Sites without a tie-breaker | Hetzner has no standard dedicated servers in NBG1, and FSN1↔HEL1 is 25 ms / 1,500 km; FSN1↔Limburg is 6 ms / 300 km; with one Site per provider, no single provider outage or API incident costs two etcd votes; with two Sites, losing the larger one stops etcd and Garage |
| 25 | Garage replication factor 3 across three Sites ([ADR-0002](docs/adr/0002-three-sites.md)) | rf=2 across two Sites with a manual switch to `dangerous` mode | Garage has no witness node; writes must survive the loss of one Site, which needs three full copies |
| 26 | One CloudNativePG Cluster per Database with one instance per compute Site; TopoLVM local storage; failback by runbook | replica cluster in NBG1; local-path-provisioner | replica clusters only fail over by hand; inside one k3s cluster the operator fails over automatically; local-path enforces no volume size |
| 27 | Backups via the Barman Cloud Plugin to Hetzner Object Storage in NBG1, a separate Hetzner project; no client-side encryption | in-tree `barmanObjectStore`; a bucket opposite the Home site; archiving to two stores | NBG1 runs no Database instance, so backups never share a location with either instance, even after failover; the in-tree path is removed in CloudNativePG 1.31; one WAL archiver per Cluster; Barman Cloud cannot encrypt client-side |
| 28 | flannel `wireguard-native` over public IPs, host firewall; Tailscale for admin access only | provider private networks (vSwitch, vRack); Tailscale as node mesh | no private network spans three providers; WireGuard encrypts all pod traffic between Sites with no extra component |
| 29 | Demo apps are the acceptance test for v1; ProjectMatch migrates after v1 | ProjectMatch cutover as step 5 | ProjectMatch is a large migration (11 DynamoDB tables to Postgres, SQS, KMS); small demo apps prove each build step sooner |
| 30 | Demo apps: `examples/notes`, `examples/spa-api`, `examples/worker`, plus Umami unmodified from its public registry | ProjectMatch only; third-party apps only | each covers one build step; `notes` doubles as the Site-failover test; Umami proves "any registry" with code we did not write |
| 31 | Customer hostnames on a separate domain on the Public Suffix List; `openupstream.com` for our own services | default hostnames under `openupstream.com` | without the PSL entry, one Project's site could set cookies for every other Project's default hostname (why `vercel.app` and `github.io` exist) |
| 32 | bunny.net DNS for our zones, with its health checks | Hetzner DNS plus our own watcher; Cloudflare | health checks run outside our Sites and outside every hosting provider's API; EU company; about $1/month. A cert-manager DNS-01 webhook for bunny.net is checked in build step 2 |
| 33 | Before revenue: cloud VMs created and destroyed per working session; the target setup (about €150–165/month) from when the demo apps pass or the first customer arrives | dedicated servers from day one | the cluster does not need to run 24/7 while it is being built; hourly billing keeps the cost down |
| 34 | Ingress is active-active: A/AAAA records for both compute Sites, failed Site dropped by DNS health checks | failover IP (Hetzner Floating or Robot IP), BGP anycast, Cloudflare Load Balancing | an IP cannot move between providers; anycast needs a leased /24 (about €150/month); Cloudflare would terminate every customer's TLS in a US company; AWS's own load balancers use the same multi-A pattern |
| 35 | Control plane schema as plain SQL migrations run by node-pg-migrate; `pg` as the Postgres client | own migration runner, Drizzle, Kysely | triggers, partial unique indexes and composite foreign keys are written in SQL anyway; node-pg-migrate adds locking, ordering checks and a CLI on top of `pg`, the standard driver |
| 36 | Invariants enforced in the schema, tested against real Postgres in Docker (testcontainers locally, a service container in CI) | enforce in application code; PGlite in-process | constraints hold for every writer, including future operators and hand-run SQL; the tests exercise the Postgres version we run |
| 37 | Pending custom-domain claims do not reserve a hostname; only verified and default Domains are unique | first claim reserves the hostname | a reservation without proof would let anyone block a hostname they do not own |
| 38 | Usage events have no foreign keys, carry the Account and outlive their Project | cascade with the Project | usage between the last rollup and a deletion must still be billed |
| 39 | Secrets: AES-256-GCM for both layers, associated data binding values to Project and name, KEK id stored per data key | one KEK-encrypted value per Secret; libsodium | `node:crypto` only; the binding stops copied rows from decrypting elsewhere; the id allows KEK rotation by rewrapping |

## Open questions

Undecided points that block or shape the design. Each one moves to the
Decisions table once it is settled.

1. **Checks before ordering servers.** Confirm the OVH "Frankfurt" probe
   really is Limburg and measure FSN1↔Limburg RTT with WireGuard over a few
   days (order the RISE-2 monthly first); check netcup's traffic allowance;
   check Hetzner "LTD" stock.
2. **Fewer slow failovers.** Chrome and Firefox switch addresses at once
   only when a Site refuses connections. Can partial failures be made to
   refuse instead of time out (host firewalls that reject rather than drop on
   80/443 when Traefik is down)? A Site that goes fully dark still waits for
   the health check.
3. **SSE-C for backups.** Does Hetzner Object Storage accept SSE-C keys passed
   to Barman Cloud?
4. **Metering Service-initiated egress.** Needs per-pod accounting (nftables
   counters or Calico flow logs); only worth it if it starts to cost us.
5. **Image pull-through cache per Site**, so a registry outage during a Site
   failure does not block restarts, without letting one Project pull
   another's private image.
6. **Retained customer logs** (searchable history) as a later product.
7. **Project deletion grace period** and backup retention window, in days.
8. **What ProjectMatch needs beyond v1**: an encrypt-only/decrypt-only key
   split like its KMS setup, and alerting to replace its CloudWatch alarm.
9. **Member roles.** Every Member can act on all of the Account's Projects
   today; whether there are roles (owner, billing, read-only) or per-Project
   access is not decided.

## Build order

0. Data model for Accounts and Projects, the routing table schema and the
   Secrets store. Everything hangs off them. Usage events are emitted from
   step 1 on. Done: `sdk/src/model.ts`, `control-plane/migrations`,
   `control-plane/src/secrets`.
1. Postgres: CloudNativePG, PgBouncer, backups to Hetzner Object Storage, a
   tested failover (a whole Site down) and a tested restore.
2. Object storage and static sites: Garage, routing table, Traefik,
   cert-manager.
3. Containers, Service mode.
4. Containers, Cron job and One-off job modes.
5. Demo apps run end to end on the platform (#30), including `notes`
   staying writable while a whole Site is switched off.

### After v1: ProjectMatch

Migrating ProjectMatch off AWS is the medium-term goal. Its inventory: 18
Lambdas (13 behind Function URLs, 2 SQS consumers, 3 invoked by other
Lambdas), 11 DynamoDB tables, 5 S3 buckets, 3 SQS queues with DLQs, SES,
one CloudFront distribution, SSM/Secrets Manager, KMS. The mapping:

- Lambdas behind Function URLs become one Service (its Express dev server
  already wraps the handlers); the two long async Lambdas become One-off
  jobs; SQS consumers become workers on `SKIP LOCKED`.
- DynamoDB tables move to Postgres; TTLs become a Cron job.
- S3 buckets become Buckets; the SPA becomes a Static site. No S3 event
  notifications or DynamoDB Streams are used, so nothing is missing there.
- SSM and Secrets Manager become Secrets. SES stays external. CloudWatch is
  dropped.

### Gate before the first invoice

Not technical, but no customer is billed before these exist: a company (UG
or GmbH), a data processing agreement (AVV) template, the TOMs, and the list
of subprocessors (Hetzner, OVHcloud, netcup, bunny.net, Stripe, the mail
provider).
