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
  seconds, RTO is the failover time of CloudNativePG (measured: writes back
  88 s after a whole Site went dark, see Postgres).
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
   Home site, standby in the      public buckets = sites     usage → invoices, Mollie
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
- Kubernetes marks the Site's node NotReady after 20 s
  (`node-monitor-grace-period`, default 50 s) and replaces its pods 30 s later
  (default not-ready and unreachable tolerations, default 300 s). CoreDNS and
  the CloudNativePG operator run twice, one per compute Site; with one
  replica each, DNS and failover waited for the eviction (#46).
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
  It is our own pinned Helm release (`infra/ingress`, #72): a DaemonSet on
  the compute nodes that takes their ports 80 and 443 as hostPorts, as the
  chart's non-root user; no load balancer in front (#73).
- A Site that goes dark stays in a Service's endpoints until Kubernetes
  marks its node NotReady. So that the other Site's Traefik does not wait
  for it, routes give up connecting after 1 s and retry on another pod;
  only requests that never reached a backend are retried. Measured on the
  dev cluster (2026-10-19): without this, 2 of 4 API requests through the
  healthy Site failed while the other went dark; with it, none of 97.
  Only GET and HEAD are retried; Traefik would also resend a request the
  dead pod had received, which must not happen to a POST.
- `ingress.<customer domain>` has A and AAAA records for both compute Sites,
  TTL 60 s. Custom domains CNAME to it. An apex domain cannot be a CNAME, and
  A/AAAA records copied into the customer's zone would never drop a failed
  Site, so apex domains need CNAME flattening (ALIAS/ANAME) at the customer's
  DNS provider, or a `www` Domain with the apex redirecting to it.
- bunny.net DNS health-checks both Sites over HTTP every 30 s from three
  regions and drops a failed Site's records. The checks run outside our
  Sites and do not depend on any hosting provider's API. They only ask port
  80 and count any answer below 500 as healthy, Traefik's HTTPS redirect
  included; their path cannot be configured. Measured: a powered-off Site
  was gone from bunny.net's answers within 35–45 s.
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
Database on the cluster, provisioned the same way as a customer's: it belongs
to a fixed platform Account and Project (`PLATFORM` in
`sdk/src/internal.ts`). The bootstrap creates that Database once; the
control plane seeds the platform rows at startup, and from then on the
operator reconciles it like any other (#56).

It runs as two replicas, one per compute Site, in the platform Project's
namespace, next to its Database, whose connection Secret CloudNativePG
creates there (`control-plane/deploy/`). At startup it applies pending
migrations; node-pg-migrate's lock lets only one replica do so (#57). It
serves two ports: the public API on 8080, and on 8081 an internal API for
the operators that ingress never routes. The internal API accepts a request
only with a ServiceAccount token issued for the audience
`openupstream-control-plane`, checked with a TokenReview, from an allowed
ServiceAccount (#53). Its one endpoint, `GET /internal/v1/databases`, lists
every Database with its Project.

The schema is plain SQL migrations in `control-plane/migrations`, applied with
node-pg-migrate; queries go through `pg` (node-postgres). The schema enforces
the data model's invariants itself: a hostname is routed for at most one
Domain, Routes only target Resources of their Domain's Project, deleting a
Project cascades to everything in it, an Account with Projects cannot be
deleted, and usage events are append-only. Its tests run against a real
Postgres in Docker. The API types are in `sdk/src/model.ts`.

The dashboard (`dashboard/`) is a Next.js app on the same API.

Sign-in for Members and API keys for `oup` and the SDK come from
[madAuth](https://madauth.com), self-hosted on the cluster as its published
image (`ghcr.io/inouiw/madauth-server`, pinned by digest) with its users in
a second Database of the platform Project, two replicas, one per compute
Site (`infra/madauth`, #63). madAuth only calls https or localhost URLs, so
a sidecar from the control plane's image, in the same pod, serves it the API
key scopes and receives its webhooks (e-mails to send, events) on
127.0.0.1. It sends madAuth's e-mails through Amazon SES in an EU region
(#66) with a key that may only send as `no-reply@openupstream.com`; with
`MAIL=log` it writes them to its log instead. madAuth is served at
`https://openupstream.com/auth/*` and the API at `https://api.openupstream.com`
(`infra/ingress/platform-routes.yaml`, #67), with a per-IP rate limit in
front of each. madAuth needs its Database for every sign-in: while that
Database fails over, sign-in is unavailable (53 s measured on the dev
cluster).

The API accepts two kinds of madAuth credentials (#64):

- a session token: a JWT (ES256, `typ: madauth-session+jwt`, issuer
  checked, no audience) verified against madAuth's JWKS, fetched from madAuth
  inside the cluster. A session may do everything its user may.
- an API key (`madauth_…`, opaque), which the user creates in madAuth and
  `oup` and scripts send. The control plane asks madAuth
  (`POST /auth/api-keys/verify`) whom it acts for and which scopes count, and
  reuses the answer for a minute, so a revoked key works for at most a
  minute more. `openupstream:read` allows every GET, `openupstream:write`
  everything.

The subject is a madAuth user, which can be a Member of several Accounts.
A signed-in user creates an Account with `POST /v1/accounts` and becomes its
first Member (#62); invitations to existing Accounts come later. Anyone
may sign up, but an Account needs a payment method (a Mollie mandate)
before it creates its first Resource (#65, #74). How someone who runs openupstream
themselves changes these rules is Open question 16.

The public API (Hono, zod validation, `control-plane/src/api`) serves
Projects and their Databases in the caller's Accounts; another Account's
Project answers 404 (#61). A Database's state (`provisioning`, `ready`,
`degraded`, `unknown`) is read live from its Cluster. Its connection details
(the Pooler's in-cluster address, database and user `app`) are returned,
the password never. Accounts and Members are not created through the API
yet.

Deleting a Project or Database only marks its row; a cleanup loop in the
control plane carries the delete out (#58): every 30 s, on one replica at a
time (a Postgres advisory lock), it removes a deleted Database's Cluster,
Pooler and ScheduledBackup at once and again on every pass for 5 minutes (an
operator pass that read the row before the delete could still re-apply
them), deletes its backups, ObjectStore and row
after the backup retention window (#60), and removes a deleted Project's
namespace and row once it has no Database rows left. A deleted name is free
again at once. On the dev cluster a deleted Database's Cluster was gone in
19 s and its volumes 15 s later.

## Operators (`operators/`)

Thin reconcilers for the things no off-the-shelf operator does:

- routing table → Traefik `IngressRoute` + cert-manager `Certificate`
- static site → Garage bucket website config and routing rules
- Database → CloudNativePG `Cluster` (two instances, one per compute Site),
  PgBouncer `Pooler`, backup schedule
- Secrets → a Kubernetes `Secret` in the Project's namespace

The step from a control plane row to Kubernetes objects is a pure function
that returns the objects or a list of errors; the reconcile loop around it
only applies and compares. The CRDs of CloudNativePG and the Barman Cloud
Plugin are vendored in `operators/crds` at the versions we run, and their
TypeScript types are generated from them at build time (not checked in), so
a misspelt or removed field fails the typecheck.

The reconcile pass talks to Kubernetes through `@kubernetes/client-node`,
with server-side apply under the field manager `openupstream-operators`
(#47). It only creates and updates: a Database's objects are deleted by the
control plane's delete of that Database or its Project, never because a row
is missing (#48). It runs in the cluster (`operators/deploy/`, one
replica) and makes a pass every 30 s with the rows from the control plane's
internal API (#49, #54). The pass is level-triggered: a missed change or a
restart costs at most one interval, and a pass that cannot get rows applies
nothing. A new Database ran 61 s after its row was inserted on the dev
cluster. Each operator's RBAC is in `operators/deploy/`; the Databases
operator may create and patch, not delete.
`operators/scripts/reconcile-databases.ts` runs a single pass from this
machine, for the bootstrap.

The control plane and operators images are built by GitHub Actions and
pushed to GHCR as public packages (`ghcr.io/openupstream/{control-plane,
operators}`, tagged with the commit), and clusters run them pinned by
digest (#55).

## Products

### Postgres

- One CloudNativePG `Cluster` per Database, two instances: the primary in the
  Database's Home site (`hetzner-fsn1` by default), a streaming standby in
  the other compute Site. Required pod anti-affinity on
  `topology.kubernetes.io/zone`, where each Site is one zone. CloudNativePG
  cannot place one instance on its own; it creates the primary first, and a
  preferred node affinity for the Home site puts it there, so the
  anti-affinity puts the standby in the other Site.
- The third Site's node carries the taint
  `openupstream.io/third-site=true:NoSchedule`, and Databases and Services
  have required node affinity to compute Sites, so nothing customer facing
  ever lands on it, even when a compute Site is full or down.
- Kubernetes objects are named by id, not by name: the Cluster is
  `db-<database id>` in the namespace `project-<project id>`. Project and
  Database names are in the labels `openupstream.io/project-name` and
  `openupstream.io/database-name`, next to `…/project-id` and
  `…/database-id`; the Cluster passes all four on to its pods, Services and
  volumes, so usage can be attributed to the Database.
- Failover is automatic inside the one k3s cluster. CloudNativePG's primary
  isolation check (on by default) shuts down a primary that can reach neither
  the API server nor its standby. There is no CloudNativePG replica cluster.
  Measured on the dev cluster (2026-10-17, primary, operator leader and
  controller-manager leader all in the Site that went dark): no acknowledged
  write lost; writes through PgBouncer back after 88 s (node NotReady after
  42 s, operator leader in the other Site after 64 s, promotion at 84 s).
  The old primary rejoins as a standby (`pg_rewind`) when its Site returns.
  Runbook: `docs/runbooks/failover-test.md`.
- Failback is a declarative switchover back to the Home site once it is
  healthy, done from a runbook, not automatically. Writes pause for about
  15 s.
- Storage is local NVMe through TopoLVM, which enforces the requested volume
  size and supports resizing.
- PgBouncer through a CloudNativePG `Pooler` of type `rw`, so it follows the
  primary: `db-<database id>-pooler`, two instances with one per compute
  Site, transaction pooling with `max_prepared_statements` so drivers'
  prepared statements work. Session features (`LISTEN`, advisory locks,
  `SET`) need a direct connection to the Cluster. TCP keepalives and
  `tcp_user_timeout` drop connections to a primary in a dark Site, which
  sends no reset (#50).
- Always on, 256 MB memory floor, pgvector enabled (created in the
  application database at bootstrap). The memory limit is also the request;
  `shared_buffers` is a quarter of it. The image is ours (`images/postgres`),
  so the DB tier does not run under gVisor; only the customer's SQL runs
  inside.

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
- Every Project gets a default hostname under a separate customer domain,
  `openupstream.app` (#68), that is on the Public Suffix List, so one
  Project's site cannot set cookies for another's. The hostname is
  `<project>-<random>.openupstream.app`, its suffix chosen once (#71). Bucket hostnames
  (`<bucket>.s3.openupstream.app`) live there too.
- `openupstream.com` is only for our own services (#67): the dashboard and
  madAuth at `openupstream.com` (madAuth under `/auth/*` and
  `/.well-known/*`, on the same site as the dashboard, as it requires), the
  API at `api.openupstream.com`.
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
  domains use HTTP-01. Wildcards (`*.s3.openupstream.app` for the Buckets)
  need DNS-01, which cert-manager solves on bunny.net through a community
  webhook, pinned and reviewed (#69). Port 80 redirects every request to
  HTTPS today; HTTP-01 for custom domains will need its challenge path
  exempted from that redirect.

## Project isolation

- One Kubernetes namespace per Project, `project-<project id>` (Project names
  are only unique per Account and can change), default-deny NetworkPolicy, also
  between Projects of the same Account. Ingress only from Traefik; Projects
  reach each other only through public Routes. The platform Project's
  namespace, where the control plane runs, also admits the operators on the
  internal API's port.
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
  deleted Resource or Project are still billed. There is at most one event
  per Resource, unit and interval start, so an emitter can retry without
  billing twice.
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
- Once a month the control plane rates each Account's usage events of the
  month before: units × the unit price, one price per unit for now (#74).
  lexoffice issues the invoice through its API (one per Account, broken
  down per Project), with the invoice number, VAT, PDF and archiving.
- Mollie collects the invoice total from the Account's mandate with a
  recurring payment (card, PayPal or SEPA Direct Debit) (#74, #75). Failed payments, and
  SEPA payments reversed up to 8 weeks later, are retried and reminded; an
  Account that stays unpaid is suspended (the rules: Open question 18).
- An Account has a Mollie customer and a mandate before it can create a
  Resource; Projects themselves are free (#65). The mandate comes from a
  first payment on Mollie's hosted checkout, paid by card (also Apple Pay
  and Google Pay), PayPal or Pay by Bank; Pay by Bank yields a SEPA Direct
  Debit mandate on the account it was paid from (#75). The checkout offers
  what is switched on in the Mollie profile, so these methods are profile
  settings, not code. The first payment's amount is Open question 18.

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
- A deleted Database's backups and ObjectStore are kept for the same
  retention window, so it can still be restored into a new Database; then
  the control plane deletes its folder from the bucket (#60).
- Each Database has its own `ObjectStore` with the plugin as its WAL
  archiver, archiving to `s3://<bucket>/project-<project id>/db-<database
  id>/`. Ids, not names: a new Database under an old name never finds the old
  one's archive. The credentials are a Secret in the Project's namespace.
- A `ScheduledBackup` takes base backups, the first right after creation,
  from the standby when there is one.
- A restore creates a new Database (new id) in the source's Project whose
  Cluster bootstraps from the source's ObjectStore up to a target time, replaying WAL across timelines,
  so also past a failover. It archives into its own folder; the source's is
  only read (#51). Tested 2026-10-17: restored to the exact last row before
  the target time, across a failover's timeline switch, in about a minute.
  Runbook: `docs/runbooks/restore-from-backup.md`.

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
| 6 | Traefik + cert-manager (Traefik as our own release, not the one bundled with k3s: #72) | Caddy outside the cluster | ships with k3s, routing table maps directly onto IngressRoute CRDs, one proxy instead of two |
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
| 18 | Usage events in the control plane's Database, ~~hourly rollups to Stripe Billing Meters~~ (rating, invoices and payments: superseded by #74) | OpenMeter self-hosted, OpenMeter Cloud, Lago | self-hosted OpenMeter needs Kafka and ClickHouse, too much for one operator; ~~Stripe already rates and invoices~~ |
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
| 32 | bunny.net DNS for our zones, with its health checks | Hetzner DNS plus our own watcher; Cloudflare | health checks run outside our Sites and outside every hosting provider's API; EU company; about $1/month. DNS-01 for certificates: #69 |
| 33 | Before revenue: cloud VMs created and destroyed per working session; the target setup (about €150–165/month) from when the demo apps pass or the first customer arrives | dedicated servers from day one | the cluster does not need to run 24/7 while it is being built; hourly billing keeps the cost down |
| 34 | Ingress is active-active: A/AAAA records for both compute Sites, failed Site dropped by DNS health checks | failover IP (Hetzner Floating or Robot IP), BGP anycast, Cloudflare Load Balancing | an IP cannot move between providers; anycast needs a leased /24 (about €150/month); Cloudflare would terminate every customer's TLS in a US company; AWS's own load balancers use the same multi-A pattern |
| 35 | Control plane schema as plain SQL migrations run by node-pg-migrate; `pg` as the Postgres client | own migration runner, Drizzle, Kysely | triggers, partial unique indexes and composite foreign keys are written in SQL anyway; node-pg-migrate adds locking, ordering checks and a CLI on top of `pg`, the standard driver |
| 36 | Invariants enforced in the schema, tested against real Postgres in Docker (testcontainers locally, a service container in CI) | enforce in application code; PGlite in-process | constraints hold for every writer, including future operators and hand-run SQL; the tests exercise the Postgres version we run |
| 37 | Pending custom-domain claims do not reserve a hostname; only verified and default Domains are unique | first claim reserves the hostname | a reservation without proof would let anyone block a hostname they do not own |
| 38 | Usage events have no foreign keys, carry the Account and outlive their Project; one event per Resource, unit and interval start | cascade with the Project; no uniqueness | usage between the last rollup and a deletion must still be billed; append-only rows cannot be corrected, so a retried emit must not create a second one |
| 39 | Secrets: AES-256-GCM for both layers, associated data binding values to Project and name, KEK id stored per data key | one KEK-encrypted value per Secret; libsodium | `node:crypto` only; the binding stops copied rows from decrypting elsewhere; the id allows KEK rotation by rewrapping |
| 40 | CRD types generated with json-schema-to-typescript from upstream CRDs vendored in `operators/crds`; generated code not checked in | hand-written types; generated code checked in; `@kubernetes-models` classes | field names and enums come from the version we run, and typos fail the typecheck; types only, no runtime dependency; an upgrade is reviewed as a CRD diff, not thousands of generated lines |
| 41 | ~~No Kubernetes client library until the reconcile loop~~, resolved by #47 | `@kubernetes/client-node` now | the first part of each operator is pure functions returning plain objects; the client is picked when there is a cluster to test it against |
| 42 | Kubernetes objects named by id (`project-<project id>`, `db-<database id>`); names only in labels | names in object names; a Service named after the Database as an alias | Project names are only unique per Account and can change; CloudNativePG caps Cluster names at 50 characters; a new Database under an old name must not reuse the old backup folder |
| 43 | PgBouncer in transaction mode with `max_prepared_statements`, one Pooler instance per compute Site | session mode; a single Pooler instance | pooling only saves connections in transaction mode, which matters at a 256 MB floor; one instance per Site keeps the Pooler up when a Site fails |
| 44 | Primary placed in the Home site by a preferred node affinity; required anti-affinity on the zone places the standby | per-instance placement (CloudNativePG has none); a switchover after creation | CloudNativePG creates the primary first, so the preference decides where it lands |
| 45 | The third Site's taint is `openupstream.io/third-site=true:NoSchedule`; customer workloads never tolerate it and require a compute Site | node affinity alone | either one alone keeps customer pods off the third Site; both guard against a mistake in the other |
| 46 | A dark Site is handled fast: `node-monitor-grace-period` 20 s, default not-ready and unreachable tolerations 30 s, CoreDNS and the CloudNativePG operator twice with a hard spread over the compute Sites (`nodeTaintsPolicy: Honor`, `matchLabelKeys: [pod-template-hash]`); the Barman Cloud Plugin once | Kubernetes defaults (50 s, 300 s, one replica each); replicas only | measured on the dev cluster: with the defaults writes stopped for 10 minutes, because DNS and the operator were in the dark Site until their eviction; with replicas and 30 s, 106 s; with 20 s as well, 88 s. Cost: a Site unreachable for more than 20 s counts as failed |
| 47 | `@kubernetes/client-node` (2.x), server-side apply under the field manager `openupstream-operators`, behind a two-method `Kube` interface | own client on `fetch`; kubernetes-fluent-client | the official client, with apply, watch and informers; the interface keeps it out of the reconcile logic and its exceptions at the boundary |
| 48 | The Database reconcile pass only creates and updates; deleting a Database's objects is an explicit step of the control plane's delete, and the operator's RBAC has no delete | delete objects without a row; delete unless the listing is empty | deleting a Cluster deletes its volumes; a wrong or empty listing must never delete a running Database |
| 49 | The operators get their rows from an internal control plane API | a read-only role on the control plane's Database | the schema stays private to the control plane |
| 50 | PgBouncer drops connections to a dead primary: TCP keepalives (10 s idle, 3 probes 5 s apart), `tcp_user_timeout` 10 s, `server_connect_timeout` 5 s | PgBouncer's defaults | a primary in a dark Site sends no TCP reset; with the defaults PgBouncer kept its connections until `server_idle_timeout` and writes stalled 3 minutes past the promotion |
| 51 | A restore is a new Database bootstrapped from the source's ObjectStore at a target time; never in place | restore into the existing Database | CloudNativePG bootstraps a Cluster only when it is created; the new id gives the restore its own archive folder, so the source's history stays intact |
| 52 | Development cluster: three Hetzner Cloud VMs per working session (fsn1; hel1 standing in for Limburg; nbg1 for the third Site) from shell scripts on the hcloud CLI in `infra/dev-cluster`; local-path storage | Terraform; TopoLVM on cloud volumes | no state to keep for a cluster that lives a few hours (#33); nodes carry the real Site names, so manifests apply unchanged. TopoLVM is not tested yet |
| 53 | The operators authenticate to the control plane's internal API with their ServiceAccount token for the audience `openupstream-control-plane`, checked by a TokenReview; only listed ServiceAccounts are answered | a shared static token in a Secret; NetworkPolicy only | no secret of our own to create or rotate; the audience check keeps every other ServiceAccount token in the cluster, which is valid for the API server, from working |
| 54 | The Databases operator makes a full pass every 30 s | a long-poll that returns early when a row changes (LISTEN/NOTIFY) | level-triggered and simple: every restart and missed change heals within one interval; a new Database waits up to 30 s |
| 55 | Images are built by GitHub Actions and published to GHCR as public packages, tagged with the commit; clusters pin them by digest | building locally and importing into k3s; private packages with a pull secret | no registry to run; the code is public anyway; pinning by digest makes every node run the same image |
| 56 | The control plane's Database belongs to a fixed platform Account and Project; the bootstrap creates it once, the control plane seeds its rows, the operator reconciles it from then on. The control plane runs in that Project's namespace | a separate Cluster outside the operator | one way to run Postgres, also for our own state; a pod can only read a Secret of its own namespace, and CloudNativePG creates the connection Secret next to the Cluster |
| 57 | The control plane applies migrations at startup | an init container; a Job per release | node-pg-migrate locks, so with two replicas exactly one migrates; nothing else to deploy |
| 58 | Deleting a Project or Database marks its row (`deleted_at`); a cleanup loop in the control plane removes the Kubernetes objects, retries until they are gone and only then removes the row. Names are unique among live rows only | delete the objects in the request, then the row; delete the row, then the objects | no orphaned Cluster keeps running and no Database is recreated empty by the operator when one step fails; a deleted name can be used again at once |
| 59 | ~~madAuth JWTs verified against madAuth's JWKS with `jose`; the subject maps to Members, possibly of several Accounts. Dev cluster and tests trust a local key (`control-plane/scripts/dev-token.mjs`)~~, superseded by #64 | token introspection at madAuth per request | no call to madAuth per request; works the same for sessions and API keys; madAuth is not deployed yet |
| 60 | A deleted Database's backups are kept for the backup retention window, then deleted with its ObjectStore | delete them with the Database; keep them until Open question 7 is settled | an accidental delete can be undone by a restore within the window; nothing is kept forever |
| 61 | Public API on Hono with zod validation: Projects and Databases first; a Database's state is read live from its Cluster; Databases are reachable inside the cluster only and the password is never returned | Fastify; plain `node:http`; the operator reporting state back; credentials through the API; external access now | small and typed; state is always current; external access (Traefik TCP with TLS SNI) is a step of its own (Open question 13) |
| 62 | A signed-in madAuth user creates an Account with `POST /v1/accounts` and becomes its first Member; a user may have several | creating it on the first API call; madAuth's `user.signed_up` webhook | explicit and repeatable, no webhook to lose (madAuth does not retry), no stray Accounts from sign-ins; the dashboard calls it on first visit |
| 63 | madAuth runs as its published image on a Postgres Database of the platform Project, two replicas; a sidecar from the control plane's image serves it the API key scopes and receives its webhooks on 127.0.0.1 | embedding madAuth in an own Node service; the image with SQLite (one replica); in-cluster TLS; changing madAuth to allow in-cluster http | no madAuth code in openupstream to build and patch; the users are in a Database with failover and backups like any other; madAuth only calls https or localhost, and the sidecar ships with the API it describes |
| 64 | madAuth session tokens (ES256, `typ: madauth-session+jwt`, no audience) verified against its JWKS; API keys checked with madAuth (`/auth/api-keys/verify`), cached for a minute; scopes `openupstream:read` (GET) and `openupstream:write` (everything) | per-resource scopes; one full-access scope | madAuth has no audience and no OAuth flows; its API keys are opaque; two scopes allow read-only keys now and finer scopes later without breaking existing keys |
| 65 | Anyone may sign up; an Account needs a payment method (card or SEPA, and PayPal since #75; a Mollie mandate since #74, first decided as Stripe) before it creates its first Resource | an allow-list or invitations; free limits per Account until billing exists | no hand-picking of customers, and no unpaid resources: memory is reserved from the first Database on. Self-hosted installations will need other rules (Open question 16) |
| 66 | madAuth's e-mails (sign-up, password reset) are sent through Amazon SES in an EU region, by the madAuth sidecar | an EU provider (Scaleway TEM, Brevo) | the maintainer already has it set up; the addresses stay in the EU region; AWS becomes a subprocessor. This is a US company, which decision 34 avoided for ingress: there Cloudflare would see every customer's traffic, here SES sees only a Member's address and the sign-in e-mails we send, never a Project's data; an EU provider remains a drop-in replacement in the sidecar |
| 67 | Our own hostnames: dashboard and madAuth at `openupstream.com` (madAuth under `/auth/*` and `/.well-known/*`), the API at `api.openupstream.com` | dashboard at `app.openupstream.com`; everything on one host | madAuth must be on the same site as the dashboard; the API on its own host keeps its routes and limits apart, and the session cookie (Domain `openupstream.com`) reaches both |
| 68 | The customer domain is `openupstream.app`: Projects' default hostnames and `<bucket>.s3.openupstream.app`, on the Public Suffix List | `openupstream.dev`; deciding later | short and clearly ours; `.app` is HTTPS-only (HSTS preloaded), like everything we serve |
| 69 | cert-manager solves DNS-01 on bunny.net with a community webhook (`aardbol/cert-manager-webhook-bunny`, chart 1.4.2, image v1.4.1 by digest, reviewed 2026-10-18; it may read one Secret); HTTP-01 for custom domains | an own webhook; delegating `_acme-challenge` to acme-dns | wildcards (Buckets) need DNS-01; the webhook exists, so no code of ours; the bunny.net API key it needs is a Secret in cert-manager's namespace only |
| 70 | DNS, certificates and e-mail are tested on the dev cluster through a dev subdomain delegated to bunny.net, Let's Encrypt staging and SES test mails | testing with a local CA and `/etc/hosts` first | the same path as production from the first session; staging keeps Let's Encrypt's rate limits out of the way |
| 71 | A Project's default hostname is `<project>-<random>.openupstream.app`, the suffix chosen once when the Project is created and kept when it is renamed | `<project>-<account>`; `<project>.<account>` | Project names are only unique per Account; a random suffix needs no unique Account names, leaks no Account name and survives renames |
| 72 | Traefik is our own Helm release (official chart, pinned, image by digest); k3s's bundled Traefik stays disabled | k3s's bundled Traefik with a HelmChartConfig | upgrades on our schedule, not with k3s; we control its CRDs and values. Keeps decision 6's choice of Traefik |
| 73 | Traefik as a DaemonSet on the compute nodes with hostPorts 80/443 (pods listen on 8000/8443, non-root, no added capabilities), no load balancer; platform routes dial with a 1 s timeout and retry on another pod | `hostNetwork`; a cloud or MetalLB load balancer | the nodes' own addresses are what bunny.net checks and hands out (#34); hostPorts keep the client address and need no root; the short dial timeout keeps a dark Site's pods from stalling requests through the other Site |
| 74 | Billing: the control plane rates usage once a month (usage events × one price per unit), lexoffice issues the invoice through its API, Mollie collects it through the Account's mandate (card, PayPal or SEPA, #75); failed payments, reminders and suspension are ours | Stripe Billing Meters, invoices and payments (#18, #65); invoice PDFs of our own; sevDesk | Mollie is an EU company the maintainer already runs for ProjectMatch, and lexoffice is the maintainer's bookkeeping, so invoices are compliant (numbering, VAT, archiving) and land there. With lexoffice issuing the invoices, Stripe would only add rating (one sum per unit at one price) and dunning (a short state machine); no US payment processor. Supersedes the Stripe parts of #18 and #65 |
| 75 | A mandate is created by a first payment on Mollie's hosted checkout with card (incl. Apple Pay and Google Pay), PayPal or Pay by Bank (which yields a SEPA Direct Debit mandate); the Mollie profile has these and SEPA Direct Debit switched on | an IBAN form of our own with Mollie's Mandates API; also iDEAL, Bancontact and EPS; one-off methods (Klarna, bank transfer) | Mollie charges these three later without the customer, and between them they cover nearly every customer in Germany and the EU. No IBAN handling and no SEPA mandate text of our own: the customer consents at their bank or card issuer. More methods that yield a mandate (iDEAL, Bancontact, EPS) are a profile setting away |

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
7. **Project deletion grace period**: whether a deleted Project can be
   undone for some days before its Kubernetes objects go. A deleted
   Database's backups are kept for the backup retention window (#60); that
   window's length, in days, is still to be set.
8. **What ProjectMatch needs beyond v1**: an encrypt-only/decrypt-only key
   split like its KMS setup, and alerting to replace its CloudWatch alarm.
9. **Member roles.** Every Member can act on all of the Account's Projects
   today; whether there are roles (owner, billing, read-only) or per-Project
   access is not decided.
10. **In-cluster clients after an API server dies.** In the failover test the
    CloudNativePG operator in the surviving Site got its leader lease only
    64 s after the other Site went dark, and the standby's instance manager
    saw the promotion request 17 s after that: they reach the API through
    the `kubernetes` Service, which still routed to the dead API server.
    This is most of the remaining 88 s. To measure: shorter client
    timeouts, or a node-local API endpoint for system pods.
11. **Pods do not move back after a Site returns.** The replacement of a
    pod from the dark Site stays in the other one, so both CloudNativePG
    operator replicas ended up in one Site. A descheduler
    (`RemovePodsViolatingTopologySpreadConstraint`) or a runbook step.
12. **Is `images/postgres` needed?** CloudNativePG's `standard` images ship
    pgvector (0.8.7 in `17-standard-trixie`); the tests ran on that image.
13. **Database access from outside the cluster.** Today only the Project's
    Services reach a Database. `psql` from a laptop or a migration from CI
    needs Traefik TCP routing with TLS SNI (Postgres 17 direct SSL), its
    certificates, and a way to hand out the password.
14. ~~**Mail for madAuth.**~~ Settled by decision 66: Amazon SES.
15. **madAuth's keys.** With `MADAUTH_KEY_SERVICE=local` the signing key is
    a Kubernetes Secret and in the process's memory; madAuth's alternative,
    AWS KMS, means an AWS dependency. And until the first admin exists,
    madAuth logs a setup token, which Loki would collect.
16. **Sign-up for those who run openupstream themselves.** The hosted
    service lets anyone sign up and requires a payment method (decision 65).
    A self-hosted installation may want something else: invitations only,
    an allow-list of domains (madAuth's `user.signing_up` webhook, in the
    sidecar), or no payment method. How these rules become configurable is
    for later.
17. **The bunny.net API key in the cluster.** cert-manager's DNS-01 webhook
    needs it, and bunny.net has one key per account with full access (no
    DNS-only key, checked 2026-10-18): whoever reads the Secret
    `cert-manager/bunny-api` controls all our DNS. Options: a separate
    bunny.net account that holds only the zones cert-manager writes to, or
    delegating `_acme-challenge` to such a zone.
18. **Billing rules with Mollie and lexoffice.**
    - The first payment that creates the mandate (#75): €0.01 refunded at
      once, kept, or a real first charge.
    - Small amounts: a month of an idle Database can cost less than the
      transaction fee or Mollie's minimum; carry it over, or a minimum
      charge.
    - Mollie's maximum per recurring payment against an unusually large
      month.
    - How failed and reversed payments are retried and reminded, and after
      how many days an Account is suspended.
    - Which lexoffice tax types cover EU business customers (reverse charge)
      and EU consumers (OSS).

## Build order

0. Data model for Accounts and Projects, the routing table schema and the
   Secrets store. Everything hangs off them. Usage events are emitted from
   step 1 on. Done: `sdk/src/model.ts`, `control-plane/migrations`,
   `control-plane/src/secrets`.
1. Postgres: CloudNativePG, PgBouncer, backups to Hetzner Object Storage, a
   tested failover (a whole Site down) and a tested restore. Done on the dev
   cluster (2026-10-17): the manifests for a Database
   (`operators/src/databases`), one reconcile pass with the backup
   credentials Secret per Project namespace, the failover test, failback and
   a point-in-time restore from NBG1; the control plane's internal API and
   the Databases operator running in the cluster on it, both from GHCR
   images; creating and deleting Projects and Databases through the
   public API, with the cleanup; madAuth with sign-up, API keys and
   Accounts created through the API (2026-10-17). Left: TopoLVM, restore
   through the API, `oup login` and `oup pg` commands. Public hostnames for
   madAuth and the API come with step 2, together with SES and the
   payment-method gate that open sign-up needs.
2. Object storage and static sites: Garage, routing table, Traefik,
   cert-manager. With Traefik come the public hostnames of the API and
   madAuth, and so open sign-up: this step also brings the sidecar's SES
   sender (#66) and the payment-method gate, a Mollie customer and mandate
   per Account checked before the first Resource (#65, #74, #75). Done on
   the dev cluster (2026-10-19): Traefik, cert-manager with DNS-01 on
   bunny.net, health-checked DNS for both Sites, the API and madAuth on
   public HTTPS hostnames, SES. Left: Garage and Buckets, the routing table
   with default hostnames (#71) and custom domains, the payment-method gate,
   the production DNS zones.
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
of subprocessors (Hetzner, OVHcloud, netcup, bunny.net, Mollie, lexoffice
for invoices, Amazon Web Services for SES). Before the first invoice the
billing run must also exist: the monthly rating, invoices through lexoffice
and collection through Mollie (#74).
