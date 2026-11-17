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
   Home site, standby in the      public buckets = sites     usage events, Holds
   other compute Site, PgBouncer                             ▲ internal API
   backups → Hetzner Object Storage NBG1 (a location         billing service (private):
   that runs no Database)                                    Mollie, lexoffice
```

## Sites and failure handling

One k3s cluster spans three Sites, each at a different provider
([ADR-0002](docs/adr/0002-three-sites.md)):

| Site | Provider, location | Runs | Role |
| --- | --- | --- | --- |
| `hetzner-fsn1` | Hetzner, Falkenstein | k3s server (etcd), Databases, Services, Traefik, Garage zone | compute Site, default Home site |
| `ovh-lim` | OVHcloud, Limburg (Frankfurt region) | k3s server (etcd), Databases, Services, Traefik, Garage zone | compute Site |
| `netcup-nbg` | netcup, Nuremberg | k3s server (etcd), Garage zone, one of the three Lokis (decision 106); no Databases or Services | third vote for etcd, third copy for Garage and for the platform's logs |

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

### Dev clusters

Two layouts run the same manifests (decision 112,
[ADR-0004](docs/adr/0004-single-node-dev-cluster.md)). `multi-node` is one
node per Site, as above: production, and the Hetzner dev cluster
(`infra/dev-cluster-hetzner`, decision 52). `single-node` is one node
standing in for every Site, for development only: it carries the label of
`hetzner-fsn1`, and everything above that needs a second Site is left out.
Garage and Loki keep one copy, a Database runs one instance and one
PgBouncer on k3s's local-path storage instead of TopoLVM (decision 109),
the platform's own components run once, and losing the node loses
everything but the backups. `infra/dev-cluster` installs onto either
(`install-multi-node.sh`, `install-single-node.sh`), records the layout in
the ConfigMap `openupstream-system/cluster-layout`, and refuses a cluster
whose nodes do not match it.

### Node network and admin access

- There is no private network across providers. Nodes talk over their public
  IPs with flannel's `wireguard-native` backend (MTU 1420), so all pod traffic
  between Sites is encrypted. NetworkPolicy is enforced by k3s's built-in
  controller.
- A host firewall on every node allows WireGuard, 80/443 and Tailscale from
  the internet, and the node-to-node ports (k3s API 6443, etcd 2379–2380,
  kubelet 10250, Garage RPC 3901) only from the other two nodes' public IPs.
  These control-plane connections are TLS (k3s, etcd) or Garage's own
  encrypted RPC; flannel's WireGuard carries pod traffic only. Pod traffic
  leaves with its node's address, so this firewall admits a pod's
  connection to another node's ports too; the customer pods' egress policy
  keeps them out instead (decision 105). It knows only the addresses a Node
  reports, so every public address a node has (an additional or failover
  IP, IPv6) must be given to k3s (`--node-ip`, `--node-external-ip`).
- gVisor (`runsc`) is added to k3s's containerd config template and
  exposed as the `gvisor` RuntimeClass; k3s does not detect it on its own.
  `infra/gvisor/install.sh` installs a pinned release, checked against the
  SHA-512 recorded in the script, on each compute node before k3s first
  starts, and writes the template (`config-v3.toml.tmpl`, extending k3s's
  base) that adds the handler `runsc` (#90). The compute nodes carry the
  label `openupstream.io/gvisor=true`, and the RuntimeClass schedules only
  there; the third Site has no gVisor. Its `overhead` reserves 64 Mi and
  10m CPU per pod for gVisor itself (50-60 MB measured), not billed.
  Tested on the dev cluster (2026-10-31): pods run under `runsc`
  (`dmesg` shows gVisor), installed on fresh Ubuntu 24.04 nodes.
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
  until DNS changes. A front with an address that outlives a Site is the
  preferred way to shorten this after v1 (open question 2).

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
operator reconciles it like any other (#56). Where a billing service runs
(`BILLING_CALLERS` set), it also seeds the billing service's Database, which
has no bootstrap: the operator creates it from the row (#79).

It runs as two replicas, one per compute Site, in the platform Project's
namespace, next to its Database, whose connection Secret CloudNativePG
creates there (`control-plane/deploy/`). At startup it applies pending
migrations; node-pg-migrate's lock lets only one replica do so (#57). It
serves two ports: the public API on 8080, and on 8081 an internal API for
the operators and the billing service that ingress never routes. The
internal API accepts a request only with a ServiceAccount token issued for
the audience `openupstream-control-plane`, checked with a TokenReview, from
a ServiceAccount listed for that route (#53). `GET /internal/v1/databases`
lists every Database with its Project, for the operators
(`ALLOWED_CALLERS`). `GET /internal/v1/accounts/{id}` returns an Account
with its Holds and Members, and `PUT` and `DELETE
/internal/v1/accounts/{id}/holds/{reason}` place and lift a Hold, for the
billing service (`BILLING_CALLERS`, none by default; #78).

The schema is plain SQL migrations in `control-plane/migrations`, applied with
node-pg-migrate; queries go through `pg` (node-postgres). The schema enforces
the data model's invariants itself: a hostname is routed for at most one
Domain, Routes only target Resources of their Domain's Project, deleting a
Project cascades to everything in it, an Account with Projects cannot be
deleted, an Account with a Hold creates no Resource, and usage events are
append-only. Its tests run against a real
Postgres in Docker. The API types are in `sdk/src/model.ts`.

The dashboard (`dashboard/`) is a Next.js app on the same API, built as
static files (#116): every page renders in the browser, which calls the API
itself through `@openupstream/sdk`, under `/api` of its own host (#120). It signs Members in and up with
madAuth's dialog (`@madauth/web`, e-mail and password), shows the approval
dialog of `oup login` when opened with `?madauth_device=<code>`, creates an
Account on the first visit (#62) and lists, creates and deletes Projects.
A Project's page lists, creates, resizes and deletes its Databases, deploys,
changes, redeploys and deletes its Services (from public images, #127),
creates and deletes its Buckets (without showing their keys, #128), claims,
verifies and deletes custom domains, adds and deletes the Routes of every
Domain, and shows what every Resource uses now, with its instances (#124);
the forms for Jobs and Secrets follow. `/cli` explains `oup` to anyone, signed in or not,
in the words of `cli/README.md` and with the installation's own API address
in the sign-in command (#125). One build serves every installation.

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
`https://console.openupstream.com/auth/*` and the API at
`https://console.openupstream.com/api/*` (`infra/ingress/platform-routes.yaml`,
#67, #120, #123), with a per-IP rate limit in front of each; Traefik strips
`/api`, so the control plane's routes start at `/v1`. Every other path of
that host is the dashboard: its static files in an nginx image of their own
(`dashboard/Dockerfile`, `dashboard/deploy/dashboard.yaml`), two replicas,
one per compute Site, that talk to nothing (#123). madAuth needs its Database for every sign-in: while that
Database fails over, sign-in is unavailable (53 s measured on the dev
cluster).

The API accepts three kinds of madAuth credentials as `Authorization:
Bearer` (#64, #87), and the session also as madAuth's cookie (#116, #120):

- a session token: a JWT (ES256, `typ: madauth-session+jwt`, issuer
  checked, no audience) verified against madAuth's JWKS, fetched from madAuth
  inside the cluster. A session may do everything its user may.
- an API key (`madauth_…`, opaque), which the user creates in madAuth and
  `oup` and scripts send. The control plane asks madAuth
  (`POST /auth/api-keys/verify`) whom it acts for and which scopes count, and
  reuses the answer for a minute, so a revoked key works for at most a
  minute more. `openupstream:read` allows every GET, `openupstream:write`
  everything.
- an access token of `oup` (`typ: at+jwt`, ES256, issuer checked, `aud` the
  CLI's client ID, valid 15 minutes), verified against the same JWKS. `oup
  login` gets it with madAuth's device authorization grant (RFC 8628, madAuth
  0.7): it shows a code and opens the approval page, where the user signs
  in with any method they have and approves; over SSH it prints the URL and
  the code instead. It asks for `offline_access`, keeps the refresh token
  (30 days from its last use, rotated on every use) in
  `~/.config/openupstream/credentials.json` (mode 600) and stores each new
  one before it uses the new access token, one `oup` process at a time
  (a lock file), since madAuth ends the chain when a refresh token is used
  twice. Like a session, it may do
  everything its user may. It carries no e-mail address, so creating an
  Account still needs a session or an API key. The CLI learns madAuth's
  issuer and its client ID from `GET /v1/login`; `OUP_API_KEY` replaces the
  sign-in in CI. An admin registers the CLI once
  (`infra/madauth/register-cli.sh`); the approval page at madAuth's
  `loginUrl` comes with the dashboard's first page.

The dashboard's JavaScript never holds a credential: madAuth keeps the
session token in an HttpOnly cookie (`madauth_session`) for the platform's
host alone, which the browser sends to the API because the API is under
`/api` of that host (#120). No subdomain receives it. The API takes the
cookie for a session token only, never an API key, and only on a request
the browser marks `Sec-Fetch-Site: same-origin`. A page of another site,
or of a subdomain, can make the browser send the cookie but not that
header, so it is answered 401 like a request without a credential (CSRF).
The API sets no CORS headers: no other origin's script reads its answers.

The subject is a madAuth user, which can be a Member of several Accounts.
A signed-in user creates an Account with `POST /v1/accounts` and becomes its
first Member (#62); invitations to existing Accounts come later. Anyone
may sign up, but an Account needs a payment method (a Mollie mandate)
before it creates its first Resource (#65, #74). The control plane knows
nothing of payments; it enforces this with Holds (#78). An Account with a
Hold gets 402 when it creates a Resource, with the Holds listed; Projects
stay free, and existing Resources keep running. New Accounts start with the
Holds in `NEW_ACCOUNT_HOLDS` (`payment-method` for the hosted service), and
the billing service lifts that Hold once the Account has a mandate. Without
a billing service nothing is held, which is what someone who runs
openupstream themselves gets by default (Open question 16).

Until the hosted service can invoice (see "Gate before the first
invoice"), its sign-up is closed and `openupstream.com` serves a waitlist
instead (#86). madAuth asks the sidecar before it creates a user (its
`user.signing_up` webhook); with `SIGNUP=closed` the sidecar refuses every
address but those in `SIGNUP_ALLOW` (addresses or `@domains`, for us), and
madAuth shows the refusal, which points to the waitlist. Users who exist
keep signing in. Sign-up is open by default, so someone who runs
openupstream themselves changes nothing. The waitlist page is served by the
control plane on a port of its own (8082, with `WAITLIST_URL` only), plain
HTML without script or cookies, routed at a host of its own with its own
certificate (`WAITLIST_DOMAIN`: `openupstream.com` for the hosted service,
whose platform domain is `console.openupstream.com`;
`infra/ingress/waitlist-route.yaml`, #123). An address
joins with a consent box and is stored as pending with the hash of a random
token, one per e-mail, so someone else asking for it breaks no link its
owner has; the control plane mails the token's link through SES with madAuth's
send-only key, and only that link puts the address on the list (double
opt-in), recording when and to which consent text. Every e-mail also has a
link that deletes the address at once; a link only shows a button, so a
mail scanner opening it changes nothing. An address gets at most one e-mail
an hour, and the page answers alike whether it is on the list already. The
cleanup loop deletes addresses unconfirmed 48 hours after their e-mail. The
page has a privacy notice and the Impressum, whose text the operator sets
(`WAITLIST_IMPRINT`).

The public API (Hono, zod validation, `control-plane/src/api`) serves
Projects and their Databases, Buckets, Services, Domains, Routes and
Secrets in the caller's Accounts; another Account's
Project answers 404 (#61). A Database's state (`provisioning`, `ready`,
`degraded`, `unknown`) is read live from its Cluster. Its connection details
(the Pooler's in-cluster address, database and user `app`) are returned,
the password never: the Project's Services and Jobs get the whole URL in
their environment instead (#97). Members are not added through the API yet.

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

- routing table → Traefik `IngressRoute` and `Middleware`s per Domain
  (the Routes operator, `operators/src/routes`, #84), and a cert-manager
  `Certificate` per custom domain (#85). A static site's website settings
  in Garage are not an operator's: the control plane sets them, since it
  alone holds Garage's admin token
- Database → CloudNativePG `Cluster` (two instances, one per compute Site),
  PgBouncer `Pooler`, backup schedule
- Service → a Deployment under gVisor and a Kubernetes Service (the
  Services operator, `operators/src/services`, #93); like the Routes
  operator it deletes its objects that no row wants any more

The step from a control plane row to Kubernetes objects is a pure function
that returns the objects or a list of errors; the reconcile loop around it
only applies and compares. The CRDs of CloudNativePG and the Barman Cloud
Plugin are vendored in `operators/crds` at the versions we run, and their
TypeScript types are generated from them at build time (not checked in), so
a misspelt or removed field fails the typecheck.

The reconcile pass talks to Kubernetes through `@kubernetes/client-node`,
with server-side apply under the field manager `openupstream-operators`
(#47). The client serializes kinds it has a model for by the model's
attribute names, which differ in places (a NetworkPolicy's `from` is
`_from`); every object is first deserialized into that shape, so what is
sent is what was written (found on the dev cluster: the peers of every
NetworkPolicy had been dropped, which admitted all traffic). It only creates and updates: a Database's objects are deleted by the
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

The operators' image has two more entry points, each a DaemonSet on the
compute nodes with no part in reconciling: the CPU agent
(`operators/deploy/cpu-agent.yaml`, decision 115, see "Metering and
billing") and the bandwidth agent (`operators/deploy/bandwidth-agent.yaml`,
decision 122, see "Project isolation"), for which the image carries
`iproute2`.

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
  anti-affinity puts the standby in the other Site. On a single-node dev
  cluster a Database runs one instance and one PgBouncer, with no standby
  (`layout` in the DatabaseConfig, decision 112).
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
- Storage is local NVMe through TopoLVM (`infra/topolvm`), as thick
  logical volumes in the volume group `openupstream` on each compute Site
  (decision 109), which lies on a RAID 1 of the server's two disks
  (decision 118): a volume reserves its full size, so a node never
  promises more disk than it has and one Database filling its volume never
  stops another. The scheduler places an instance only where its size
  still fits (Kubernetes' storage capacity tracking). 10 GB of each group
  stay free.
- A Database is resized through the API, `PATCH …/databases/{id}` with
  `memoryMb` and `storageGb`, and `oup pg resize` (decision 110). Storage
  only grows, online: TopoLVM extends the volume and its filesystem
  without a restart (8 GB in about 3 s once applied). A new memory size
  makes CloudNativePG restart the standby, then the primary in place, so
  it stays in its Home site; the primary's smart shutdown waits at most
  30 s for PgBouncer's connections (CloudNativePG's default is 180 s), and
  PgBouncer retries a failed login after 1 s instead of 15 s. Measured on
  the dev cluster: one write pause of 12 s, 1.5 minutes in all, against
  16 s and 4 minutes with the defaults; a switchover paused 8 s but left
  the primary in the other Site. The API reports `resizing` until the
  Cluster asks for the row's sizes and no volume is still growing.
  Growing is refused while the Account has a Hold, and with 507 when the
  nodes lack room: a new Database needs its storage (TopoLVM's free space)
  and its memory (a node's allocatable memory less what its pods request,
  RuntimeClass overhead included)
  on a node in each compute Site, a grow the extra on the nodes holding
  its instances. Without the check the row (and the bill) took a size the
  volume never reached, and a Database too large for any node stayed
  `provisioning`. When Kubernetes cannot be asked, the size is accepted
  unchecked rather than refusing every create. A grow that fails anyway
  (two requests taking the same room) reads `resizing` and fires the alert
  `DatabaseVolumeResizeFailed`; it completes by itself once there is room.
- Storage grows by itself (decision 111): on by default, without a limit
  unless the customer sets `maxStorageGb`; `autoGrow: false` leaves it to
  resizing. A pass of the control plane every 30 s reads each volume's use
  from the platform's Prometheus (`kubelet_volume_stats_*`, `PROMETHEUS_URL`)
  and, once a Database's fullest volume is 90% used, raises `storageGb` by
  half (at least 1 GB), never past the maximum, by less if the nodes have
  less room, through the same row change as a resize. It skips a Database
  whose volume has not reached its last size yet, and one whose Account
  has a Hold. A volume that fills up anyway, faster than a pass, stops
  Postgres; CloudNativePG then waits in the phase `Not enough disk space`
  for its PVCs to grow but does not grow them when the Cluster's size
  rises (dev cluster, 2026-11-15), so the pass grows the PVCs of such a
  Cluster once it has its row's size, whether grown by itself or by a
  resize. The primary then waits out Kubernetes' crash-loop back-off
  (up to 5 minutes) before it starts again. Without Prometheus nothing grows by itself, and neither where the volumes are a node's own disk (`DATABASE_VOLUMES=shared`, a single node, decision 124); `DatabaseVolumeFull`
  (over 95% for 10 minutes) catches every Database that did not grow:
  auto-grow off or at its maximum, a held Account, a full node, or a
  runaway writer that growth keeps up with until the node is full.
- PgBouncer through a CloudNativePG `Pooler` of type `rw`, so it follows the
  primary: `db-<database id>-pooler`, two instances with one per compute
  Site, transaction pooling with `max_prepared_statements` so drivers'
  prepared statements work. Session features (`LISTEN`, advisory locks,
  `SET`) need a direct connection to the Cluster. TCP keepalives and
  `tcp_user_timeout` drop connections to a primary in a dark Site, which
  sends no reset (#50).
- Reachable from inside the cluster only: the Project's Services and Jobs.
  Access from a Member's own machine is proposed as `oup pg proxy`
  (decision 126) and not built; at its `owner` level it would reach the
  primary past the Pooler, for migrations.
- Always on, 256 MB memory floor, pgvector enabled (created in the
  application database at bootstrap). The memory limit is also the request;
  `shared_buffers` is a quarter of it. The image is ours (`images/postgres`),
  so the DB tier does not run under gVisor; only the customer's SQL runs
  inside.

### Object storage

- Garage with replication factor 3, one zone per Site, `consistent` mode.
  Every object is stored once in each Site; reads and writes need two of
  three, so they keep working while any one Site is down. It runs from our
  own manifests (`infra/garage`): a StatefulSet with one node per Site, the
  third Site included, that find each other through Kubernetes; the layout
  (a node's zone is its Site) is assigned once when the cluster is set up
  (#83).
- Keys and buckets are managed by the control plane through Garage's admin
  API (`control-plane/src/garage.ts`). A Bucket is a Garage bucket with the
  Bucket's name as its global alias and a key of its own that may read and
  write that bucket and no other; the API shows the key with the Bucket,
  since Garage keeps the secret (#81). Creating one calls Garage while the
  request waits, and the row is recorded only once Garage has both: a 201
  means the Bucket is usable, a Garage outage is a 503 (#82).
- Deleting a Bucket deletes every object in it; nothing is kept, unlike a
  Database's backups. The DELETE deletes its key at once, so nothing written
  afterwards is lost unnoticed; the cleanup deletes the key too if Garage
  was unreachable then, empties the bucket with the control plane's own key
  and deletes it. The name stays taken until then (#82).
- An API key with only `openupstream:read` sees a Bucket's key id but not
  its secret, since the Bucket's key may write (#81).
- Traefik's entry point cuts a request after 60 s (its default
  `readTimeout`), so a single PUT has to finish within a minute; S3 clients
  upload large files in parts anyway. Raising it for the S3 routes only
  needs an entry point of their own.
- The S3 API is served through Traefik, virtual-hosted style only
  (`<bucket>.s3.<customer domain>`), so every request is attributable to one
  Bucket for metering. Bucket names are hostnames, so they are unique across
  all Projects. One wildcard certificate covers them (DNS-01, #69).
- No bucket event notifications (Garage does not implement them).

### Static sites

- A public Bucket served at a Domain through the routing table, using
  Garage's website endpoint behind Traefik (#84). Creating a Route turns the
  Bucket into a website in Garage (`index.html` for a directory) while the
  request waits; deleting its last Route turns that off again. Only the
  website endpoint is public this way: the Bucket's S3 API still needs its
  key.
- The Route's path prefix is stripped: `/docs/guide.html` on the Route
  `/docs` serves the object `guide.html`, so one built site can be mounted
  at any prefix.
- SPA fallback is a Garage routing rule: a 404 serves `index.html` with
  status 200. Garage keeps it per Bucket, so every Route to one Bucket has
  the same setting (#84).
- Cache headers are object metadata, set when `oup site deploy` uploads each
  file: files with a content hash in the name get
  `max-age=31536000, immutable`, `index.html` gets `no-cache`, everything else
  `max-age=300`. Files uploaded with another S3 client keep whatever headers
  that client set; ingress does not rewrite them.
- `oup site deploy <dir> --bucket <name>` makes the Bucket mirror the
  directory (#88): it uploads only files whose MD5 differs from the
  object's ETag, every `index.html` after the other files, so a client that
  loads the new one finds the assets it names, then deletes the objects the
  directory no longer has; `--keep` leaves them, `--force` uploads every
  file, rewriting the headers of objects another client put there. Dotfiles stay out, except
  `.well-known`. It uses the Bucket's own key, which the API hands to a
  caller who may write.
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
- A Service is a row in the control plane (#92): `POST …/services` with its
  image, port, replicas, memory and CPU, `PATCH` to change it, `POST
  …/services/{id}/deploy` to resolve the same tag again, `DELETE` (409
  while a Route serves it). Its state (`deploying`, `running`, `degraded`)
  is read live from its Deployment. The Services operator stamps the
  Deployment with the spec version it applied (pinned image, replicas,
  resources, port, Site, Secrets version; `serviceSpecVersion` in the sdk),
  and until it carries the version the row asks for now, the Service is
  `deploying`: a change is never reported `running` on the old version
  before the operator's next pass (#94). The control plane resolves the tag to
  a digest while the request waits, with the registry's token flow: an image
  the registry does not have, or will not serve with the given credentials,
  is a 400, a registry that cannot be reached a 503, and nothing is written.
  Only a new image, new credentials or a deploy resolve again, so scaling
  never moves the image.
- The registry is the customer's choice, so the control plane reaches it
  over https only and refuses one whose name resolves to a loopback,
  private, link-local or shared address: a Service cannot make the control
  plane call into the cluster or a private network. The check is made when
  the name is looked up; a registry that changes its DNS answer before the
  request is not caught.
- Pull credentials (`registryAuth`, a username and password) are sealed with
  the Project's data key like a Secret's value and never returned. The
  control plane renders all of a Project's into one
  `kubernetes.io/dockerconfigjson` Secret, `project-registry-auth`, an entry
  per Service under its image's repository (`ghcr.io/acme/api`), which
  kubelet matches as a prefix of the image it pulls; every Service names
  it in `imagePullSecrets`. Two Services of one Project that pull the same
  repository with different credentials share one entry. Credentials go
  only to their own registry: a new image at another registry drops them,
  and a redirect to another host is followed without them.
- Without a `homeSite` of its own, a single replica runs in the Home site of
  the Project's oldest live Database, else in `hetzner-fsn1`.
- The Services operator (#93) runs each Service as a Deployment `svc-<id>`
  with the image by digest and `runtimeClassName: gvisor`, and a Kubernetes
  Service of the same name for its Routes. A Service without a port is a
  worker (#98), such as a queue consumer on `SKIP LOCKED` (#8): no
  Kubernetes Service, no readiness probe (it is ready once it has run for
  10 s, so one that crashes at start does not replace the old pods), and
  no Route may serve it, nor may a routed Service drop its port. A single replica has a
  preferred node affinity for its Site, so it moves to the other when that
  one fails; two or more have a hard topology spread over the compute
  Sites that leaves out a dark Site's tainted node (as in decision 46).
  Rollouts start the new pod before stopping the old one. Requests and
  limits are both the configured memory and CPU, so the memory billed is
  reserved and no Service takes another's CPU; CPU is billed as measured,
  not as reserved (Open question 23). A pod may write 2 GiB to its
  container's filesystem and logs (`ephemeral-storage`, decision 121),
  the same for every Service and Job and not billed: the kubelet evicts a
  pod above it, so a Service's pod is replaced by a new, empty one and a
  Job's run ends. Nothing a container writes there outlives its pod
  anyway; data belongs in a Database or a Bucket. The scheduler counts
  100 MiB of it per pod, so the limit is not reserved on the node's disk.
  Pods mount no
  ServiceAccount token, read `project-secrets` with `envFrom` and do not
  start before it exists; a version of the Project's Secrets on the pod
  template rolls the Service when they change. The control plane records
  that version only after it wrote the new values, so pods never restart
  into the old ones.
- Every Service and Job gets a URL per live Database of its Project
  (#97): `DATABASE_URL_<NAME>` (the name upper-cased, `-` as `_`) and the
  oldest Database's also as `DATABASE_URL`, pointing at its Pooler. The
  operator writes only a `secretKeyRef` to CloudNativePG's `db-<id>-app`
  Secret (as `OUP_DATABASE_PASSWORD_<NAME>`, also in the environment) and
  a `$(VAR)` reference in the URL, so the password stays in the Project's
  namespace. A pod waits for that Secret, so a Service created with its
  Database starts once the Database is up. A Database added or deleted
  changes the Service's and Job's spec version: the Service rolls and is
  `deploying` until the new Database is up (its old pods keep serving
  meanwhile; a Database that never comes up holds the rollout until it is
  deleted), and the Job is `deploying` until its CronJob has the new URLs;
  a run started before the new Database is up waits for it, within its
  timeout. These variables win over a Project Secret of the same name.
- A Job (#95, [ADR-0003](docs/adr/0003-jobs.md)) is a row like a Service:
  `POST …/jobs` with its image, optional `command` (the entrypoint) and
  `args`, memory, CPU, a timeout (default 1 h, at most 24 h) and an
  optional `schedule` (five cron fields or `@hourly`…`@yearly`) read in an
  optional IANA `timeZone` (default UTC); `PATCH`, `POST …/deploy` and
  `DELETE` as for a Service. A Job with a schedule is a Cron job. Its image
  is pinned at deploy and its pull credentials go into
  `project-registry-auth` like a Service's, so every run starts the same
  digest without asking the registry.
- `POST …/jobs/{id}/runs`, with optional `args` and `env`, starts a
  One-off job from any Job while the request waits: the control plane
  copies the `jobTemplate` of the Job's CronJob into a Kubernetes Job, owned
  by the CronJob but not controlled by it, with the run's arguments, so the
  CronJob's history limits and overlap rule count only scheduled runs. An Account with a Hold starts
  none (402). Runs are read live from Kubernetes, scheduled and started
  alike; there is no run history in the control plane.
- The Jobs operator applies one CronJob `job-<id>` per Job, suspended when
  the Job has no schedule, with the pod rules of a Service (gVisor, image
  by digest, requests = limits, no ServiceAccount token, `envFrom`
  `project-secrets`, the Databases' URLs, the egress policy), in the Job's
  Site by preference.
  It carries the spec version of the row (`jobSpecVersion` in the sdk);
  until it carries the current one the Job is `deploying` and a run is
  refused with 409, so no run starts from an old template. A run is never
  retried (`backoffLimit: 0`), a Cron job never overlaps its previous run
  (the due one is skipped), every run is stopped at its Job's timeout, and
  a finished run stays 24 hours, so its logs can be read; a Cron job keeps
  at most its last 3 successful and 3 failed scheduled runs. A scheduled
  run more than 5 minutes late is skipped, so a Cron job does not catch up
  on what it missed. The Secrets are not part of the spec version: a run's
  pod reads them when it starts. Deleting a Job deletes
  its CronJob, and Kubernetes its runs.

## Routing and domains

- The routing table lives in the control plane: `Domain → [(path prefix →
  Bucket | Service)]`. A Domain belongs to exactly one Project and its Routes
  target only that Project's Buckets and Services, so ingress never crosses
  namespaces.
- Every Project gets a default hostname under a separate customer domain,
  `openupstream.app` (#68), that is on the Public Suffix List, so one
  Project's site cannot set cookies for another's. The hostname is
  `<project>-<random>.openupstream.app`, its suffix chosen once (#71): the
  Project's default Domain, created with the Project. One wildcard
  certificate, `*.openupstream.app`, is the default certificate of
  Traefik's TLS store, so no default Domain needs one of its own (#84).
  Bucket hostnames (`<bucket>.s3.openupstream.app`) live there too.
- `openupstream.com` is only for our own services (#67). The hosted
  service is at `console.openupstream.com`, its platform domain (#123): the
  dashboard, madAuth under `/auth/*` and `/.well-known/*` (on the same site
  as the dashboard, as it requires) and the API under `/api` (#120).
  `openupstream.com` itself is the product's welcome page and never shows
  the dashboard; until the hosted service opens for sign-up it is the
  waitlist (#86). Another installation serves the dashboard at its own
  platform domain and has no waitlist unless it closes sign-up.
- Both zones are hosted on bunny.net DNS (see Ingress and failover).
- A custom domain is routed and gets a certificate only after the Account
  proves ownership with a TXT record at `_openupstream.<domain>`. A Domain
  appears in the routing table at most once; a new claim needs a new proof.
  A pending claim does not reserve the hostname: several Projects may claim
  it, the first to publish the proof gets it, so nobody can squat a hostname
  they do not own. The proof is a random token per claim, looked up through
  the cluster's resolver when the Account asks for verification
  (`POST …/domains/{id}/verify`) and not checked again afterwards (#85).
  The cluster's resolver caches a missing record for up to 30 s, so a
  verify right after publishing it may need a retry.
  Hostnames under the customer domain and our own domain cannot be claimed,
  nor one another Project has verified. Deleting a custom domain deletes
  its Routes; the default Domain goes only with its Project.
- A Route sends a path prefix (`/` or `/a/b`, no trailing slash) to a Bucket,
  optionally with SPA fallback, or to a Service. A Service gets the path
  as it came, prefix included (#93); only a Bucket's prefix is stripped.
  Like the platform's own routes, Traefik gives up connecting to a
  Service's pod after 1 s and retries GET and HEAD on another; the longer
  prefix always wins, whatever the method (explicit rule priorities). A Bucket or Service that a
  Route still targets cannot be deleted; deleting a Domain deletes its
  Routes, and deleting a Project deletes its Domains at once, so nothing of
  it is served any more.
- The Routes operator applies, every 30 s, one IngressRoute per Domain and
  Resource in the Project's namespace (`domain-<id>-bucket-<id>`,
  `domain-<id>-svc-<id>`), so Traefik's per-rule metrics name the Resource
  for metering (decision 114); the rules of several IngressRoutes for one
  hostname compete by priority alone, as within one. A Middleware per Route that sets the Host
  header to the Bucket's name (how Garage's website endpoint finds the
  Bucket) and one that strips the prefix. It reaches Garage through an
  ExternalName Service in that namespace, since Traefik does not route
  across namespaces. A custom domain also gets a cert-manager Certificate
  there, which its IngressRoute uses. Unlike the Databases operator it
  deletes: objects of its own that the routing table no longer has (#84),
  a Certificate's Secret with it (#85).
- Traefik and cert-manager do ingress and TLS; certificates for custom
  domains use HTTP-01, since their zones are not ours. Wildcards
  (`*.s3.openupstream.app` for the Buckets) need DNS-01, which cert-manager
  solves on bunny.net through a community webhook, pinned and reviewed
  (#69). Port 80 redirects every request to HTTPS, except the HTTP-01
  challenges: the same ClusterIssuers pick an HTTP-01 solver for
  Certificates labelled `openupstream.io/component=routes`, whose challenge
  Ingress Traefik serves on port 80 ahead of the redirect, which has the
  lowest priority. Traefik's Ingress provider sees only those solver
  Ingresses (#85). A custom domain thus needs its CNAME to
  `ingress.<customer domain>` before its first Route: the Certificate is
  requested with it, and after a failed attempt cert-manager waits an hour
  before the next. Deleting and re-adding the Route starts over.

## Project isolation

- One Kubernetes namespace per Project, `project-<project id>` (Project names
  are only unique per Account and can change), default-deny NetworkPolicy, also
  between Projects of the same Account. Ingress only from Traefik; Projects
  reach each other only through public Routes. The platform Project's
  namespace, where the control plane runs, also admits the operators on the
  internal API's port.
- The NetworkPolicy `project-isolation` (#89) lets a Project's pods accept
  connections from each other (a Service to its Database's Pooler, a
  standby to its primary), from Traefik's namespace and from
  CloudNativePG's operator in `cnpg-system`, which asks each instance for
  its status; nothing else. Every operator that applies a Project's
  namespace applies it right after the namespace, before anything else goes
  in, so no pod of a Project runs unisolated. The operators' exception in
  the platform namespace is a second policy in `control-plane/deploy/`.
- The NetworkPolicy `database-metrics`, applied by the Databases operator
  with each Project that has a Database, adds one exception for
  CloudNativePG's pods only (`cnpg.io/cluster`): Prometheus's pods in
  `monitoring` may reach their metrics ports, 9187 and 9127 (decision
  106). No other pod of a Project, and no other pod in `monitoring`.
- Egress to the internet is allowed. A Service's pods may connect only to
  DNS, their own Project's namespace (its Databases' Poolers) and public
  addresses: the
  NetworkPolicy `service-egress` (#93) leaves out every loopback, private,
  shared and link-local range, which holds the cluster's pod and service
  networks, the nodes' private addresses and metadata endpoints. Their
  Buckets they reach at their public hostnames. Through the node a pod runs
  on, Traefik's hostPort rewrites such a connection to Traefik's pod
  address before the policy sees it, so the policy also allows Traefik's
  pods by selector, on their ports 8000 and 8443 only (decision 104). The
  same egress applies to a Job's runs (`job-egress`). The nodes' own
  addresses, where the Kubernetes API, kubelet and etcd listen, are left
  out too and allowed on TCP 80 and 443 only (decision 105): the Services
  and Jobs operators list the Nodes on every pass and watch them, so a
  node that joins is left out at once, and a pass that cannot list them
  applies nothing. The `kubernetes` Service's address is rewritten to a
  node's 6443 before the policy sees it, so it is closed with them.
- Every pod of a Service or Job is limited to 300 Mbit/s in each
  direction (decision 122), all its traffic counted, to its Databases and
  from Traefik too. The operators set the annotations
  `kubernetes.io/ingress-bandwidth` and `kubernetes.io/egress-bandwidth`,
  from which the `bandwidth` plugin in k3s's CNI configuration puts a token
  bucket on the pod's interface on the node when the pod starts; it works
  the same under gVisor. Four pods at that limit still fill a 1 Gbit/s
  uplink, and the CNI gives each bucket a burst of 512 MB, so the bandwidth
  agent (`operators/src/bandwidth-agent`, a DaemonSet on the compute
  nodes) looks every second: it sets a new pod's burst to a tenth of a
  second of its limit, and while the node's uplink carries more than 80%
  of its speed in a direction it lowers every customer pod's limit in that
  direction to the fair share. Pods below the share keep their traffic,
  the pods at their limit split the rest equally, never below 10 Mbit/s,
  and all are back at 300 once there is room. The platform's own traffic
  (Database replication, Traefik, Garage) is never limited; the pods give
  way to it. The agent takes the uplink's speed from its interface on
  every pass, or from `UPLINK_MBIT` (set through `platform.sh`) where that
  reports none or more than the line carries; without a speed it only
  sets bursts. A limit follows down from a change of 1% and up from 5%. It runs on the node's
  network as root with NET_ADMIN and no other capability, uses neither the
  Kubernetes API nor a port, and sets every pod back to 300 when it stops.
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
  namespace (`secrets-kek`); k3s secrets encryption at rest is on. On the
  production cluster a copy is kept outside it, with the maintainer's
  credentials: without the key, neither the cluster nor a restore of the
  control plane's Database can read any Secret. The dev cluster's is
  generated per session and thrown away with it.
- The control plane renders all of a Project's Secrets into one Kubernetes
  `Secret`, `project-secrets`, in the Project's namespace (#91): right after
  every change through the API, and again every 30 s on one replica (an
  advisory lock, like the cleanup), so a write that failed, or that came
  before an operator created the namespace, arrives within one pass; a
  Project with Services but no Secrets gets an empty one, since a Service's
  pods wait for it rather than start without their values (the
  API does not wait for its write; a replica runs a Project's API writes
  one after another, so two quick changes land in order; a pass, or a
  write from the other replica, can still cross one, which the next pass
  repairs). It
  alone holds the key-encryption key, so no decrypted value crosses the
  internal API. Services and jobs read the Secret via `envFrom`. Changing a
  Secret rolls the Services that use it.
- The API takes a value with `PUT …/secrets/{name}` (an environment
  variable name) and never returns it; a value is at most 64 KiB and a
  Project's values together at most 512 KiB, since they share one
  Kubernetes Secret and every container's environment.
- The envelope protects copies of the control plane's Database that leave the
  cluster (backups). It does not protect against someone with cluster-admin;
  that is accepted.

## Metering and billing

- Usage events are written to an append-only table in the control plane's
  Database, keyed by Project and Resource, by the control plane's metering
  pass (`src/usage/meter.ts`, decision 114): every completed hour, once its
  last scrapes have settled (5 minutes), becomes one event per Resource and
  unit. The hours it has recorded are listed (`metered_hours`), so it goes
  on where it stopped after a restart or an outage, back to 14 days
  (Prometheus keeps 15), and the billing service rates a month only once
  all its hours are metered. An hour is recorded only when Prometheus and
  Garage answered; one that Prometheus has no samples for waits two hours,
  then is recorded from the rows alone (logged), so it cannot hold back the
  hours after it. A Bucket Garage cannot size counts as empty and is
  logged. Without Prometheus the pass does not run; every install has one
  (decision 124), a single-node dev cluster included.
  A trigger rejects updates, deletes and truncation.
- What a Resource uses now is a different question from what it is billed,
  and the API answers it (`GET /v1/projects/{id}/usage`, decision 124;
  `control-plane/src/usage/live.ts`): every Resource with its instances
  (a Database's instances and PgBouncers, a Service's replicas, a Job's
  runs: their Site, state, restarts and start), and for each instance and
  Resource the CPU of the last two minutes, the memory in use and, for a
  Database, the disk in use, next to what was given. The pods come from
  Kubernetes, the figures from the same Prometheus as metering: CPU from
  the CPU agent's counter, so it is the count that is billed; memory from
  the pod cgroup's working set; a Database's disk from its volume, or from
  Postgres's own sizes (databases and WAL) where the volumes are
  directories of the node's disk and report that disk's use. A Bucket's
  bytes come from Garage. When Prometheus does not answer, the instances
  are still listed and the answer says nothing was measured.
  Events have no foreign keys and carry the Account: the last hours of a
  deleted Resource or Project are still billed. There is at most one event
  per Resource, unit and interval start, so an emitter can retry without
  billing twice.
- Units (GB is 2^30 bytes, as the sizes are); Resources are Databases,
  Buckets, Services and Jobs:
  - `cpu_seconds`: actual consumption, summed over all pods of a Resource
    (both Database instances and its Pooler, all replicas of a Service, all
    runs of a Job), from the CPU agent (decision 115): a DaemonSet on the
    compute nodes that reads each pod's total from its cgroup (the kernel's
    exact count, gVisor's sandbox included) every second and the moment the
    pod's last process exits, and keeps the final total in Prometheus for 15
    minutes. A pod's hour is its total at the end of the hour less at the
    end of the hour before. cAdvisor's counter, scraped every 30 s, missed up
    to 30 s at each end of a pod's life and every Job run shorter than that:
    a 5-second run's cgroup, with its total, was gone half a second after it
    ended (dev cluster, 2026-11-15). When the agent first runs on a node, a
    pod's CPU from before lands in the first metered hour.
  - `memory_gb_hours`: the reserved size. A Database's from its row,
    counted once, for the part of the hour it existed. A Service's from
    Prometheus: each running pod's memory request for the minutes it ran,
    so replicas count, and a deleted Service's last hour is not lost (its
    row is gone); a rollout's extra pod counts while it runs. A Job's runs
    are too short to sample: each run's memory request for exactly the
    seconds it ran, from kube-state-metrics' start and completion times.
  - `storage_gb_hours`: logical size, counted once: the volume size of a
    Database from its row, the bytes stored in a Bucket as Garage counts
    them when the hour is metered.
  - `egress_gb`: Traefik's response bytes over the hour per rule. Traefik
    names a rule's service `<namespace>-<IngressRoute>-<hash of the
    rule>`, and the IngressRoute is per Domain and Resource, so the name
    carries the Resource, also of a Route deleted before its hour is
    metered.
- The billing service reads an Account's month through the internal API,
  `GET /internal/v1/accounts/{id}/usage?month=YYYY-MM`: quantities summed
  per Project, Resource and unit, with the hours metered so far.
- Unit prices include the copies in the other Sites; the invoice shows what
  the customer configured or stored, not how many copies we keep.
- Connections a Service opens to the internet are not metered or billed
  (Open question 4).
- Payments, invoices and dunning are a separate program, the billing
  service, kept in a private repository with its own image and its own
  Database in the platform Project (#77, #79). It takes the internal API's
  types from `@openupstream/sdk` on npm (#80). It sees Accounts and usage only
  through the control plane's internal API and stops an Account through
  Holds (#78). Everything below is the billing service's.
- Once a month the billing service rates each Account's usage events of the
  month before: units × the unit price, one price per unit for now (#74).
  lexoffice issues the invoice through its API (one per Account, broken
  down per Project), with the invoice number, VAT, PDF and archiving.
- Mollie collects the invoice total from the Account's mandate with a
  recurring payment (card, PayPal or SEPA Direct Debit) (#74, #75). Failed
  payments, and SEPA payments reversed up to 8 weeks later, are retried and
  reminded; an Account that stays unpaid gets a Hold, and is later
  suspended (the rules: Open question 18).
- An Account has a Mollie customer and a mandate before it can create a
  Resource; Projects themselves are free (#65). Until then it has the Hold
  `payment-method` (#78). The mandate comes from a
  first payment on Mollie's hosted checkout, paid by card (also Apple Pay
  and Google Pay), PayPal or Pay by Bank; Pay by Bank yields a SEPA Direct
  Debit mandate on the account it was paid from (#75). The checkout offers
  what is switched on in the Mollie profile, so the profile has exactly
  these methods switched on; another method that yields a mandate is a new
  decision, not just a profile setting. The first payment is €0.01 for
  every method and is refunded as soon as it is paid (#76).

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
- Customers restore through the API: `restoreFrom: {databaseId,
  targetTime?}` on creating a Database, `oup pg restore` (decision 108).
  The source is any Database of the Project, live or deleted within the
  retention window; without a target time the restore replays the whole
  archive. The row keeps the source and the time; the operator renders the
  recovery bootstrap until the cleanup pass sees a ready instance and
  records the restore as finished, then renders the Cluster like any other.
  It must not keep naming the source's ObjectStore: once that is gone (the
  source's retention passed), the Barman Cloud plugin stops every
  reconcile of the Cluster, and a restored Database whose primary died
  stayed without one (dev cluster, 2026-11-10). The
  API checks the time first against the source ObjectStore's recovery
  window: not before its oldest base backup, and at least 5 minutes before
  now or before the source's deletion (CloudNativePG's `archive_timeout`;
  a later time can lie in WAL not archived yet, and Postgres refuses a
  recovery that ends before its target). A restore that could only fail
  is refused instead of left `provisioning`. The cleanup does not purge a
  source while a restore from it is unfinished (for at most a day), so a
  restore accepted just before the source's retention ends still finds its
  archive. The platform's own
  Databases, whose loss stops the API, are restored by runbook:
  `docs/runbooks/restore-from-backup.md`.

## Observability and customer logs

- For us: Prometheus, Alertmanager, Grafana and Loki in the namespace
  `monitoring` (`infra/monitoring`, installed by
  `infra/dev-cluster/monitoring.sh` as a step of every install; decisions
  106 and 124). Without an alert address it sends nothing and needs neither
  the SES key nor the dead man's switch. kube-prometheus-stack
  runs Prometheus and Alertmanager once per compute Site, so a dead Site is
  alerted on by the other; both Prometheus replicas scrape everything (15
  days, at most 18 GB each) and the two Alertmanagers send each alert once.
  Grafana runs once, reached by port-forward and later over Tailscale,
  never through Traefik.
- Scraped beyond the stack's defaults (nodes on all three Sites, kubelet,
  the Kubernetes API, kube-state-metrics): every Database's instances and
  Poolers in any Project's namespace, Garage, Traefik and cert-manager
  (`scrape.yaml`). k3s keeps the scheduler, controller manager, proxy and
  etcd inside its own process without their metrics, so those scrapes and
  alerts are off.
- Alerts: the stack's defaults for nodes, disks, the Kubernetes API and
  Prometheus itself, its workload alerts (crash loops, unavailable
  replicas, failed Jobs) for the platform's namespaces only, and ours
  (`rules.yaml`): a Database instance down, a Database without its
  standby, replication lag over a minute, WAL archiving failing for 15
  minutes with nothing archived (counted by failures, as a quiet Database
  piles up few WAL files), a Database volume over 95% full or failing to
  grow (decision 111), Garage
  unhealthy or a storage node down, a certificate expiring within 14 days
  or not ready, a Traefik pod down. A customer's crashing Service is not
  ours to be woken for; their Databases are. Alertmanager mails them
  through SES's SMTP interface with the send-only key (password derived by
  `ses-smtp-password.mjs`), and pings the always-firing `Watchdog` to
  healthchecks.io every minute, which mails when the pings stop: a dark
  cluster or a dead Alertmanager is noticed too (decision 107).
- Loki runs in single-binary mode three times, one per Site, the third
  Site included, with its chunks and index in the Garage bucket
  `openupstream.platform-logs` (a dot, so no customer can take the name),
  kept 14 days. Every stream goes to all three and a write needs two
  (replication factor 3, Loki's standard for high availability), so with
  any one Site dark logs keep coming in and stay queryable; the dark
  replica replays its WAL from its node's disk when the Site returns. The
  third Site's Loki is limited to 1 GiB of memory so it cannot crowd out
  etcd there. One known gap: a query started in the first minute of a
  Site failure, before Loki marks the dark replica unhealthy, can hang
  about 15 minutes (until TCP gives up on the dead host); it answers when
  run again, as every later query skips the dark replica. Alloy on every
  node ships the logs of the
  platform's namespaces only, never a Project's (decision 21): the list is
  the same as the workload alerts' (`kube-system`, `monitoring`,
  `traefik`, `cert-manager`, `cnpg-system`, `garage`,
  `openupstream-system`, the platform Project's namespace).
- Tested on the dev cluster (2026-11-10): every scrape target up, among
  them all four Database instances through the Project's NetworkPolicy and
  node-exporter on all three Sites; Loki held the platform's namespaces
  only; a test alert went out through SES and the `Watchdog` reached
  healthchecks.io once a minute (with `repeat_interval` 1 m it came every
  2 m, so it is 50 s). With hetzner-fsn1 powered off, Alertmanager on
  ovh-lim mailed the Database, Garage, Traefik and target alerts and kept
  pinging. Found there: the Loki chart's `global.extraArgs` do not reach
  the single-binary pod, and the first WAL rule (more than 10 files
  waiting) stayed silent through over a thousand failed archive attempts.
  A second run tested what the pull request's review changed: the
  `database-metrics` policy let a pod labelled as Prometheus reach a
  Database instance (9187) and a Pooler (9127) but not the control plane,
  and an unlabelled pod in `monitoring` reach neither; the certificate
  alerts see each Certificate's own namespace, limited to the platform's
  (a customer's custom domain failing because they moved its DNS is theirs
  to see in its status). Two Lokis with replication factor 1 failed the
  Site test: Loki never forgets the last other ring member (it might be a
  partition), so the dark one's streams refused writes, Alloy dropped 20
  minutes of logs and queries failed. With three, one per Site,
  hetzner-fsn1 off for 25 minutes: every minute ingested, nothing dropped,
  pushes and queries answered in 0.15 and 0.23 s, and loki-0 replayed its
  WAL on return; Loki on the third Site used 21 m CPU and 166 MiB.
- For customers: a log stream endpoint that tails the Kubernetes logs API
  (current and previous container). Nothing is retained. Per Service
  (`GET …/services/{id}/logs`, all replicas) and per run (`GET
  …/jobs/{id}/runs/{runId}/logs`), as NDJSON, one `{pod, site, time,
  line, previous}` per line (decision 103). The control plane finds the
  pods by label (`openupstream.io/service-id`, and
  `batch.kubernetes.io/job-name` for a run), reads each container with
  `timestamps=true` (a running one after a restart also its previous log,
  the crash; a crash-looping one only its previous log, the run that
  crashed) and, without `follow`, sends the last `tail` lines of
  all of them sorted by time. With `follow` it lists the pods again every
  5 s: a replica a rollout starts is added, a container that restarted is
  read on from the last line sent (`sinceTime` counts whole seconds, so
  lines of that second are dropped by time), a read of a pod that is gone
  is stopped. A followed stream ends after an hour, when the client goes,
  or once no container is left that can write, so it ends with a run. It
  sends an empty line every 30 s as a heartbeat, and its readers wait on
  Kubernetes rather than queue more than 1000 entries for a slow client;
  an Account has at most 10 open at once per control-plane replica (429
  beyond). `tail=0` reads from now on (`sinceTime`): the Kubernetes client
  drops `tailLines=0`, which then means the whole log. A snapshot keeps at
  most the newest 4 MiB of lines per container.
  `oup service logs` and `oup job logs` print it.

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
| 24 | Three Sites at three providers: compute at Hetzner Falkenstein and OVHcloud Limburg, third Site (etcd and Garage; since decision 106 also one of three Lokis) at netcup Nuremberg ([ADR-0002](docs/adr/0002-three-sites.md)) | Hetzner FSN1 + NBG1 + HEL1; OVH Limburg + Strasbourg; two Sites without a tie-breaker | Hetzner has no standard dedicated servers in NBG1, and FSN1↔HEL1 is 25 ms / 1,500 km; FSN1↔Limburg is 6 ms / 300 km; with one Site per provider, no single provider outage or API incident costs two etcd votes; with two Sites, losing the larger one stops etcd and Garage |
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
| 52 | Development cluster: three Hetzner Cloud VMs per working session (fsn1; hel1 standing in for Limburg; nbg1 for the third Site) from shell scripts on the hcloud CLI in `infra/dev-cluster-hetzner`, the platform installed onto them by `infra/dev-cluster` (decision 112); Databases on TopoLVM on a Hetzner Cloud Volume per compute VM (decision 109; local-path before it) | Terraform; TopoLVM on cloud volumes | no state to keep for a cluster that lives a few hours (#33); nodes carry the real Site names, so manifests apply unchanged |
| 53 | The operators authenticate to the control plane's internal API with their ServiceAccount token for the audience `openupstream-control-plane`, checked by a TokenReview; only listed ServiceAccounts are answered, per route since #78 | a shared static token in a Secret; NetworkPolicy only | no secret of our own to create or rotate; the audience check keeps every other ServiceAccount token in the cluster, which is valid for the API server, from working |
| 54 | The Databases operator makes a full pass every 30 s | a long-poll that returns early when a row changes (LISTEN/NOTIFY) | level-triggered and simple: every restart and missed change heals within one interval; a new Database waits up to 30 s |
| 55 | Images are built by GitHub Actions and published to GHCR as public packages, tagged with the commit; clusters pin them by digest | building locally and importing into k3s; private packages with a pull secret | no registry to run; the code is public anyway; pinning by digest makes every node run the same image |
| 56 | The control plane's Database belongs to a fixed platform Account and Project; the bootstrap creates it once, the control plane seeds its rows, the operator reconciles it from then on. The control plane runs in that Project's namespace | a separate Cluster outside the operator | one way to run Postgres, also for our own state; a pod can only read a Secret of its own namespace, and CloudNativePG creates the connection Secret next to the Cluster |
| 57 | The control plane applies migrations at startup | an init container; a Job per release | node-pg-migrate locks, so with two replicas exactly one migrates; nothing else to deploy |
| 58 | Deleting a Project or Database marks its row (`deleted_at`); a cleanup loop in the control plane removes the Kubernetes objects, retries until they are gone and only then removes the row. Names are unique among live rows only | delete the objects in the request, then the row; delete the row, then the objects | no orphaned Cluster keeps running and no Database is recreated empty by the operator when one step fails; a deleted name can be used again at once |
| 59 | ~~madAuth JWTs verified against madAuth's JWKS with `jose`; the subject maps to Members, possibly of several Accounts. Dev cluster and tests trust a local key (`control-plane/scripts/dev-token.mjs`)~~, superseded by #64 | token introspection at madAuth per request | no call to madAuth per request; works the same for sessions and API keys; madAuth is not deployed yet |
| 60 | A deleted Database's backups are kept for the backup retention window, then deleted with its ObjectStore | delete them with the Database; keep them until Open question 7 is settled | an accidental delete can be undone by a restore within the window; nothing is kept forever |
| 61 | Public API on Hono with zod validation: Projects and Databases first; a Database's state is read live from its Cluster; Databases are reachable inside the cluster only and the password is never returned | Fastify; plain `node:http`; the operator reporting state back; credentials through the API; external access now | small and typed; state is always current; external access is a step of its own (decision 126, Open question 13) |
| 62 | A signed-in madAuth user creates an Account with `POST /v1/accounts` and becomes its first Member; a user may have several | creating it on the first API call; madAuth's `user.signed_up` webhook | explicit and repeatable, no webhook to lose (madAuth does not retry), no stray Accounts from sign-ins; the dashboard calls it on first visit |
| 63 | madAuth runs as its published image on a Postgres Database of the platform Project, two replicas; a sidecar from the control plane's image serves it the API key scopes and receives its webhooks on 127.0.0.1 | embedding madAuth in an own Node service; the image with SQLite (one replica); in-cluster TLS; changing madAuth to allow in-cluster http | no madAuth code in openupstream to build and patch; the users are in a Database with failover and backups like any other; madAuth only calls https or localhost, and the sidecar ships with the API it describes |
| 64 | madAuth session tokens (ES256, `typ: madauth-session+jwt`, no audience) verified against its JWKS; API keys checked with madAuth (`/auth/api-keys/verify`), cached for a minute; scopes `openupstream:read` (GET) and `openupstream:write` (everything) | per-resource scopes; one full-access scope | madAuth has no audience and no OAuth flows; its API keys are opaque; two scopes allow read-only keys now and finer scopes later without breaking existing keys |
| 65 | Anyone may sign up; an Account needs a payment method (card or SEPA, and PayPal since #75; a Mollie mandate since #74, first decided as Stripe) before it creates its first Resource; enforced with a Hold since #78 | an allow-list or invitations; free limits per Account until billing exists | no hand-picking of customers, and no unpaid resources: memory is reserved from the first Database on. Self-hosted installations will need other rules (Open question 16). "Anyone may sign up" is suspended on the hosted service until it can invoice (#86) |
| 66 | madAuth's e-mails (sign-up, password reset) are sent through Amazon SES in an EU region, by the madAuth sidecar | an EU provider (Scaleway TEM, Brevo) | the maintainer already has it set up; the addresses stay in the EU region; AWS becomes a subprocessor. This is a US company, which decision 34 avoided for ingress: there Cloudflare would see every customer's traffic, here SES sees only a Member's address and the sign-in e-mails we send, never a Project's data; an EU provider remains a drop-in replacement in the sidecar |
| 67 | (The hosted service's host is `console.openupstream.com` since decision 123; `openupstream.com` is the welcome page.) Our own hostnames: dashboard and madAuth at `openupstream.com` (madAuth under `/auth/*` and `/.well-known/*`), the API at `api.openupstream.com` (under `/api` of the same host since #120) | dashboard at `app.openupstream.com`; everything on one host | madAuth must be on the same site as the dashboard; the API on its own host keeps its routes and limits apart, and the session cookie (Domain `openupstream.com`) reaches both |
| 68 | The customer domain is `openupstream.app`: Projects' default hostnames and `<bucket>.s3.openupstream.app`, on the Public Suffix List | `openupstream.dev`; deciding later | short and clearly ours; `.app` is HTTPS-only (HSTS preloaded), like everything we serve |
| 69 | cert-manager solves DNS-01 on bunny.net with a community webhook (`aardbol/cert-manager-webhook-bunny`, chart 1.4.2, image v1.4.1 by digest, reviewed 2026-10-18; it may read one Secret); HTTP-01 for custom domains | an own webhook; delegating `_acme-challenge` to acme-dns | wildcards (Buckets) need DNS-01; the webhook exists, so no code of ours; the bunny.net API key it needs is a Secret in cert-manager's namespace only |
| 70 | DNS, certificates and e-mail are tested on the dev cluster through a dev subdomain delegated to bunny.net, Let's Encrypt staging and SES test mails | testing with a local CA and `/etc/hosts` first | the same path as production from the first session; staging keeps Let's Encrypt's rate limits out of the way |
| 71 | A Project's default hostname is `<project>-<random>.openupstream.app`, the suffix chosen once when the Project is created and kept when it is renamed | `<project>-<account>`; `<project>.<account>` | Project names are only unique per Account; a random suffix needs no unique Account names, leaks no Account name and survives renames |
| 72 | Traefik is our own Helm release (official chart, pinned, image by digest); k3s's bundled Traefik stays disabled | k3s's bundled Traefik with a HelmChartConfig | upgrades on our schedule, not with k3s; we control its CRDs and values. Keeps decision 6's choice of Traefik |
| 73 | Traefik as a DaemonSet on the compute nodes with hostPorts 80/443 (pods listen on 8000/8443, non-root, no added capabilities), no load balancer; platform routes dial with a 1 s timeout and retry on another pod | `hostNetwork`; a cloud or MetalLB load balancer | the nodes' own addresses are what bunny.net checks and hands out (#34); hostPorts keep the client address and need no root; the short dial timeout keeps a dark Site's pods from stalling requests through the other Site |
| 74 | Billing: the billing service (the control plane until #77) rates usage once a month (usage events × one price per unit), lexoffice issues the invoice through its API, Mollie collects it through the Account's mandate (card, PayPal or SEPA, #75); failed payments, reminders and suspension are ours | Stripe Billing Meters, invoices and payments (#18, #65); invoice PDFs of our own; sevDesk | Mollie is an EU company the maintainer already runs for ProjectMatch, and lexoffice is the maintainer's bookkeeping, so invoices are compliant (numbering, VAT, archiving) and land there. With lexoffice issuing the invoices, Stripe would only add rating (one sum per unit at one price) and dunning (a short state machine); no US payment processor. Supersedes the Stripe parts of #18 and #65 |
| 75 | A mandate is created by a first payment on Mollie's hosted checkout with card (incl. Apple Pay and Google Pay), PayPal or Pay by Bank (which yields a SEPA Direct Debit mandate); the Mollie profile has these and SEPA Direct Debit switched on | an IBAN form of our own with Mollie's Mandates API; also iDEAL, Bancontact and EPS; one-off methods (Klarna, bank transfer) | Mollie charges these three later without the customer, and between them they cover nearly every customer in Germany and the EU. No IBAN handling and no SEPA mandate text of our own: the customer consents at their bank, card issuer or PayPal. More methods that yield a mandate (iDEAL, Bancontact, EPS) are a profile setting away, recorded here first |
| 76 | The first payment that creates the mandate is €0.01 for every method, refunded through Mollie's Refunds API as soon as it is paid | €0 for cards where Mollie allows it; keeping the €0.01; a first month in advance | one amount and one flow for card, PayPal and Pay by Bank; the customer is charged nothing for adding a payment method; usage-based pricing has nothing to charge in advance. Costs a transaction fee per added payment method |
| 77 | Payments, invoices and dunning live in a private billing service: its own repository, image and Database in the platform Project. The open repository keeps Accounts, Members, usage events and Holds | billing in the open repository, switched off with a setting | someone who runs openupstream needs the hosting code, not how we take payments; the Mollie and lexoffice keys never reach the open control plane; the seam (#78) is generic, so others can plug in their own rules. Costs a second repository, CI and a private image the cluster needs a pull Secret for; customers can read how their usage is measured, not how it becomes an invoice |
| 78 | An Account's Holds stop it from creating Resources (402, the Holds listed; they also show in the Account). New Accounts start with the Holds in `NEW_ACCOUNT_HOLDS`, none by default. The billing service reads Accounts and places and lifts Holds through the internal API, allowed only for the ServiceAccounts in `BILLING_CALLERS` | one "may create Resources" flag; asking the billing service on every create | independent reasons (no payment method, unpaid) add up without their setters knowing of each other; creating a Resource never waits for the billing service; with no Holds configured there is no gate. Existing Resources keep running; suspending them is dunning (Open question 18) |
| 79 | The billing service's Database is a third fixed platform Database (`PLATFORM.billingDatabase`, id …0005), seeded by the control plane only when `BILLING_CALLERS` is set | the billing service creating its own Database through a new internal API route | failover and backups like the other platform Databases, no new route or permission; installations without a billing service get no Database for it |
| 80 | `@openupstream/sdk` and `@openupstream/cli` (`oup`) are published to npm by GitHub Actions workflows on `sdk-v<version>` and `cli-v<version>` tags, with npm trusted publishing (OIDC) and provenance; the billing service depends on the SDK for the internal API's types. Only admins may create those tags (tag rulesets); the jobs run in the GitHub Environment `npm-release`, which needs a maintainer's approval, and npm trusts only each package's workflow in that environment; every action is pinned to a commit SHA. The CLI is installed with the SDK from npm, so an SDK release comes first when the CLI needs a newer one; the CLI workflow checks that version is on npm and that the packed CLI installs and runs | the billing service keeping its own copy of the types; a long-lived npm token in a repository secret; npm's staged publishing, approved on npmjs.com; bundling the SDK into the CLI (one package, no SDK release first) | one definition of the contract between the two repositories; publishing needs no secret, every version can be traced to its commit, and a release needs an admin's tag and an approval click on GitHub. Both packages were meant for customers anyway; `npm i -g @openupstream/cli` is how `oup` is installed. Costs: a CLI change that needs an SDK change takes two releases |
| 81 | Every Bucket has a Garage key of its own, created with it, that may read and write that Bucket and no other; the API shows it with the Bucket (Garage keeps the secret) | keys per Project with permissions the customer chooses (read-only, several Buckets); one key per Project for all its Buckets | the simplest model that is still least privilege: a leaked key exposes one Bucket, and a Service can later get exactly the keys of the Buckets it uses. Keys of their own, read-only keys or one key for several Buckets are a later addition |
| 82 | A Bucket is created in Garage while the API request waits, and its row recorded only after that; deleting marks the row and the cleanup removes key, objects and bucket, keeping nothing. Buckets are reached at `https://<bucket>.s3.<customer domain>` through Traefik with one wildcard certificate | a row first and a reconcile loop, as for Databases; a retention window for deleted Buckets; the S3 endpoint only inside the cluster | a 201 means the Bucket can be used at once, with no state to poll and no second loop; Garage being down is a 503 the client can retry. Deleting is what the customer asked for, and keeping objects would mean billing for storage they deleted. A process that dies between Garage and the insert leaves an empty Garage bucket whose name stays taken |
| 83 | Garage runs from our own manifests: a StatefulSet with one node per Site, Kubernetes discovery with its CustomResourceDefinition installed by us, the layout assigned once by the setup script | Garage's Helm chart (not published to a chart repository, only in Garage's git repository); letting Garage create its CustomResourceDefinition; connecting nodes by hand | a hundred lines of YAML we can read in one go, like the rest of `infra/`; Garage only needs rights on its own GarageNode objects, not to create any CustomResourceDefinition; nodes find each other again after restarts without a script |
| 84 | Static sites: Garage's website endpoint behind Traefik. The control plane sets a Bucket's website settings (index, SPA fallback) in Garage when a Route is created; a Routes operator applies an IngressRoute per Domain (since decision 114: per Domain and Resource) with per-Route Middlewares (Host header = Bucket name, prefix stripped) and an ExternalName Service to Garage, and deletes its objects the routing table no longer has; default Domains share one wildcard certificate in Traefik's default TLS store; SPA fallback is per Bucket, so Routes to one Bucket must agree | the control plane writing the Traefik objects itself; keeping the prefix in object keys; SPA fallback in Traefik's errors middleware; a certificate per default Domain | the operator pattern of the Databases, with Garage's admin token staying in the control plane only; one site mounts at any prefix; Garage already has the routing rule; a wildcard needs no issuance per Project. Contradicts the earlier plan of an operator writing Garage's website settings. Traefik must allow ExternalName Services, which only the Routes operator creates |
| 85 | Custom domains: a claim gets a random token, published by the Account as TXT at `_openupstream.<domain>` and looked up when it calls verify, once, through the cluster's resolver; hostnames under the customer and platform domains, or verified by another Project, cannot be claimed; the Routes operator gives a verified custom domain with Routes a cert-manager Certificate (HTTP-01, selected by label on the existing ClusterIssuers) and deletes it with the Domain, its Secret garbage-collected through cert-manager's owner references | the control plane polling pending claims; re-checking the TXT record periodically; a separate HTTP-01 ClusterIssuer; DNS-01 by CNAME-delegating `_acme-challenge` to us | verification while the request waits, like Buckets, gives the Account its answer at once; a removed record does not take a site down, the claim is what was proven; one issuer per environment keeps the platform's and customers' certificates on the same account; HTTP-01 needs nothing from the customer beyond the CNAME the traffic needs anyway. Traefik's Ingress provider is enabled, limited to cert-manager's solver Ingresses, and its port-80 redirect drops to the lowest priority |
| 86 | (The waitlist has a host of its own since decision 123, no longer the platform host's remaining paths.) Until a company exists and the hosted service can invoice ("Gate before the first invoice"), its sign-up is closed and `openupstream.com` serves a waitlist. This suspends decision 65's "anyone may sign up" there, not its payment-method gate; sign-up opens again (`SIGNUP=open`) once the gate is passed, and the waitlist is mailed once and deleted. Closed by the madAuth sidecar answering `user.signing_up` (`SIGNUP=closed`, `SIGNUP_ALLOW` for us), open by default. The waitlist: a page served by the control plane on its own port, its addresses in a table of the control plane's Database, double opt-in with a token link per e-mail, mailed through SES with madAuth's send-only key, a removal link in every e-mail, unconfirmed addresses deleted after 48 hours, at most one e-mail per address an hour, Traefik's per-IP limit on the form; English, with a consent text, privacy notice and an Impressum the operator sets | open sign-up with every new Account held (`NEW_ACCOUNT_HOLDS`); invitations only; a static page in a Bucket through the routing table, or an nginx container, posting to the API; single opt-in; a mailing-list provider | no Accounts to clean up or disappoint, and nobody signs up for something they cannot use; madAuth has no switch of its own, and the webhook covers every sign-up method, OAuth included. The page needs no dashboard, no CORS and no second image; a Bucket would need a Domain at `openupstream.com` in the platform Project. Double opt-in and a removal link are what German law (UWG § 7, Art. 7 GDPR) expects as proof of consent; no list provider means no further subprocessor. Self-hosters keep open sign-up without setting anything |
| 87 | `oup login` uses madAuth's device authorization grant (RFC 8628, madAuth 0.7) as the public client `oup CLI`, asking for `openid email offline_access`; the control plane accepts madAuth access tokens (`at+jwt`, `aud` = `CLI_CLIENT_ID`) with a session's rights and tells the CLI the issuer and client ID at `GET /v1/login`; the refresh token is kept in `~/.config/openupstream/credentials.json` (mode 600) and each new one stored before use; `OUP_API_KEY` for CI | authorization code with PKCE and a loopback redirect; both flows; e-mail and password in the terminal turned into an API key; pasting an API key | the flow RFC 8628 wrote for command-line tools, as `gh auth login` and `az login` use: it works over SSH, in containers and on headless machines, with every sign-in method, passkeys included; `verification_uri_complete` makes it one click when a browser is at hand, so a loopback flow would add code for no gain; a password in the terminal would leave out passkey users. madAuth refuses clients without `deviceFlow`, and only an admin with a fresh sign-in registers one |
| 88 | `oup site deploy` makes the Bucket mirror the directory: changed files only (MD5 against the ETag), `index.html` files after the rest, then stale objects deleted (`--keep` to leave them); cache headers and content types from the file name | upload only, never delete | a deploy should leave exactly the build behind, or deleted pages stay reachable; uploading the index last keeps a client from loading an index whose assets are not there yet; hashed assets of the previous build go with it, so a page open from before the deploy may miss a lazily loaded chunk; `--keep` is for sites that need that |
| 89 | Every Project namespace gets one NetworkPolicy, `project-isolation`: ingress from the Project's own pods, Traefik's namespace and `cnpg-system`, nothing else; egress open. The operators apply it right after the namespace; the platform namespace's exception for the operators (port 8081) is a static policy next to the control plane | a policy per Database and per Service; a deny-all policy plus one allow policy per source; Calico instead of k3s's built-in policy controller | one object that every operator applies identically under the shared field manager, so whichever operator creates the namespace isolates it before anything runs there; same-namespace traffic is what a Project needs inside (Services to Poolers, CloudNativePG replication); k3s enforces it without another CNI. Egress for customer containers is decided with the Services operator |
| 90 | gVisor is installed by a script on each compute node before k3s starts (`infra/gvisor/install.sh`): a pinned release whose archive is checked against a SHA-512 in the script, and a containerd config template that extends k3s's base with the handler `runsc`. The RuntimeClass `gvisor` selects nodes labelled `openupstream.io/gvisor=true` | gVisor's apt repository; a privileged DaemonSet that installs runsc on the nodes | a node setup step like k3s itself, with nothing privileged left running in the cluster; the pin makes every node run the same sandbox, and an upgrade is a reviewed change of two lines; the apt repository serves whatever is newest. The label keeps gVisor pods off a node without runsc, where they would never start |
| 91 | The control plane writes the Kubernetes Secret `project-secrets` per Project itself, after each change and in a 30 s pass; no Secrets operator. The public API: `GET …/secrets` (names), `PUT …/secrets/{name}` `{value}`, `DELETE …/secrets/{name}`; every Service of the Project gets all of them | a Secrets operator fed decrypted values by an internal API route (the earlier plan of decision 20); per-Service selection of Secrets | the control plane alone holds the key-encryption key, so plaintext never travels between processes and no operator can read every Project's Secrets; it needs `create` and `patch` on Secrets cluster-wide, which a Secrets operator would have needed as well. Project-wide Secrets match how they are described to customers; selecting per Service can come later without changing the API |
| 92 | Services API: a Service is a row, created, changed (`PATCH`) and redeployed (`POST …/deploy`) through the API, its state read from its Deployment. The control plane resolves the tag to a digest at the registry while the request waits, over https and never at a private address; pull credentials are per Service, sealed with the Project's data key, and rendered into one dockerconfigjson Secret per Project keyed by repository | Deployments as immutable records with history and rollback; the operator resolving tags on its pass; named registry credentials shared by Services; a pull Secret per Service | the pattern of Buckets: a 201 means the image exists and can be pulled, and a bad tag or credentials is an answer, not a state to poll; the operator never needs credentials or the internet. One Secret per Project lives and dies with the namespace and needs no pruning by the control plane; kubelet's prefix match keeps credentials per repository. Rollback is a `PATCH` back to a digest (`image@sha256:…`) |
| 93 | A Services operator (`OPERATOR=services`, own ServiceAccount) applies per Service a Deployment (gVisor, image by digest, requests = limits, no ServiceAccount token, `envFrom` `project-secrets` required, Secrets version on the pod template) and a Kubernetes Service, plus per Project the NetworkPolicy `service-egress`, and deletes what no row wants. Routes to a Service keep the path, dial with a 1 s timeout and retry GET and HEAD only | extending the Routes operator; `optional` Secrets; stripping the prefix as for Buckets; egress left open | each operator keeps only the rights it needs and one concern per pass; a pod that waited for its Secrets never runs without them; apps behind `/api` usually expect their full path; customer code must not reach Garage's admin API, the control plane or other Projects from inside the cluster, so only the internet and its own namespace are open |
| 94 | `oup` acts on the Project linked to the directory (`oup link` writes its id to `.openupstream.json`, found upwards like `.git`; `--project` or `OUP_PROJECT` override; `oup project create <name> --link` makes and links one, in the caller's only Account unless `--account` names another); `oup service deploy` is one idempotent command (create, else change what differs, else deploy the tag again; always resolves the tag, then waits until running); Secret values and registry passwords come from stdin only | `--project` on every command; separate create/update/redeploy verbs mirroring the API; `NAME=value` arguments | the directory is where the code of one Project lives, as with Vercel or Railway, and the id survives renames; the same deploy line works for the first and every later deploy, locally and in CI; arguments end up in shell history and the process list |
| 95 | Jobs ([ADR-0003](docs/adr/0003-jobs.md)): one `…/jobs` resource (image pinned at deploy, command, args, resources, timeout, optional `schedule` and `timeZone`); a schedule makes it a Cron job, `POST …/jobs/{id}/runs` (args, env) starts a One-off job. The control plane creates that Kubernetes Job while the request waits, as a copy of the `jobTemplate` of the Job's CronJob, which the Jobs operator applies (suspended without a schedule). Runs are read from Kubernetes only, kept 24 h. No retries, no overlap, timeout default 1 h, at most 24 h, UTC unless a time zone is given | a One-off job running a Service's image with another command (Render, Heroku); self-contained runs that carry their image; the operator creating runs from rows; run rows in the control plane; the pod template in the sdk; Kubernetes' defaults, or retries and overlap per Job | runs start in seconds and from the pinned digest, without a registry call; the pod rules are written once, in the operator, and deleting a Job deletes its runs by garbage collection; no table to keep in step with Kubernetes. Costs: a run is refused for up to one operator pass after a change, no history beyond a day, and the control plane may create and delete Jobs in every Project namespace |
| 96 | `oup job` is one group for Jobs and their runs: `oup job deploy` is idempotent like `oup service deploy` (the command after `--` or `--no-command`, `--schedule` or `--no-schedule`, waits until ready); `oup job run` starts a One-off job (args after `--`, `--env NAME=value`) and waits for its outcome, exiting 1 when it failed, unless `--no-wait`; `oup job runs`, `stop`, `list`, `show`, `delete` | `oup cron` and `oup run` as two commands (the earlier plan); `oup job run` returning at once with `--wait` to opt in | one noun, as in the API and the glossary, for a Job that is scheduled and started by hand alike; a CI step that runs a migration fails when the migration does, without a flag to remember |
| 97 | Every Service and Job gets `DATABASE_URL_<NAME>` per live Database of its Project and the oldest one's as `DATABASE_URL`, built by Kubernetes from a `secretKeyRef` to CloudNativePG's `db-<id>-app` Secret; the Databases are part of the spec version | binding Databases to Services and Jobs explicitly (as Render and Railway reference them); the user copying a URL into a Secret (as `fly postgres attach` writes one); the control plane writing the URL into `project-secrets` | Heroku's model: no API or CLI field, nothing to bind before the first deploy, and the right default for one Database per Project; the password never leaves the namespace or passes through the control plane, which never sees it; a Project's pods can already reach all its Databases (decision 89), so a binding would add no isolation. Explicit binding can come later as a filter |
| 98 | A Service's `port` is optional: without one it is a worker, with no Kubernetes Service and no readiness probe, and no Route may serve it (refused on the Route, and a trigger refuses removing a routed Service's port); `oup service deploy` needs `--no-port` for one | workers as a mode of their own; keeping the port required and having workers serve a health endpoint | Render's background workers, Heroku's worker dynos and Fly processes without services work the same way; ProjectMatch's SQS consumers become such workers; a fake listener would make readiness mean nothing; `--no-port` keeps a forgotten `--port` from silently making a worker |
| 99 | The demo apps (#30) are one npm workspace, `examples/`, a folder per app on plain `node:http` and `pg` (and the AWS SDK's S3 client for a Bucket, decision 100), built by the Images workflow from one Dockerfile (`APP` build argument) into `ghcr.io/openupstream/example-<app>`, public | a repository of their own; one image for all apps; a web framework | they change with the platform in the same PR and are built for the commit under test; the workspace puts their tests under the repo's CI; one image per app keeps each deploy line the customer's (`oup service deploy notes --image …/example-notes`); a framework would hide what the platform needs from a container |
| 100 | The demo app `spa-api` is a single-page app in one Bucket at `/` with SPA fallback and a Service at `/api` on the same hostname that keeps uploaded files (up to 1 MiB) in a second Bucket over S3, with the AWS SDK's S3 client. The Service reads the Bucket's access from four Secrets (`BUCKET_ENDPOINT`, `BUCKET_REGION`, `BUCKET_ACCESS_KEY_ID`, `BUCKET_SECRET_ACCESS_KEY`) copied from what the API shows for the Bucket; downloads are `attachment` with CSP `sandbox`, so an uploaded page never runs on the app's origin | a stateless API; the browser uploading straight to the Bucket with presigned URLs | step 2 is object storage as well as static sites, and ProjectMatch's five S3 buckets are reached from its code; proxying through the Service needs no CORS on Garage; copying the key by hand is what a customer does today and shows what binding Buckets like Databases (decision 97) would save (Open question 19) |
| 101 | Node.js 24 everywhere (`.nvmrc`, `engines`, CI, the images); the control plane's tests start one Postgres server per run in a node:test global setup (`--test-global-setup`), each test file still creating and dropping its own database on it | staying on Node 22 with a wrapper script that starts the container and then runs `node --test`; testcontainers' reuse mode | a container per test file, about 21 starting at once, failed 3 of 15 local runs under Docker load; global setup is node:test's own hook and exists from Node 24.0 on; reuse locks only within one process, so the parallel test files would still race, and the container outlives the run. Node 24 is the active LTS, and the images run what the tests run. Costs: contributors need Node 24, and the hook is still Stability 1.0, so it may change in a minor release |
| 102 | The demo app `worker` is one image with three commands on one Database: the image's own a Service without a port taking tasks with `FOR UPDATE SKIP LOCKED`, each taken and done in one transaction and polled every second; `enqueue` a One-off job that adds a batch and exits 0 once workers have done it all; `cleanup` a Cron job deleting tasks done more than a day ago | jobs only, with no queue; a worker on the `notes` Database; `LISTEN`/`NOTIFY` instead of polling; a queue library (pg-boss, Graphile Worker) | step 4 and the worker Services of decision 98 each get a demo, and ProjectMatch's SQS consumers and DynamoDB TTLs take the same shapes after v1; `enqueue` waiting makes `oup job run` the proof that the workers ran, before there is a log stream; the Pooler's transaction mode has no `LISTEN`; plain SQL shows the pattern decision 8 points customers to. Costs: a task holds its transaction (and a Pooler connection) while it runs, and an empty queue costs a query per replica a second |
| 103 | The log stream is chunked HTTP of NDJSON, one LogEntry per line, read by the control plane from the Kubernetes logs API per container and merged; a followed stream lists the pods again every 5 s and lasts at most an hour | plain text lines with a pod prefix (Heroku `logs --tail`, `kubectl logs -f --prefix`); Server-Sent Events; WebSockets (Render, Railway); polling a JSON endpoint with a cursor (Fly.io) | structured entries need no parsing in the dashboard and can gain fields; `fetch()` reads a chunked body while sending the `Authorization` header, which `EventSource` cannot, so SSE would put the token in the URL; the pod list again picks up rollouts and restarts without a watch. Costs: each follower holds one Kubernetes API connection per container on a control-plane replica (hence 10 followed streams per Account and replica), an idle stream lists pods every 5 s, and a client that wants more than an hour reconnects |
| 104 | The customer egress policy (`service-egress`, `job-egress`) also allows Traefik's pods by namespace and pod selector, on their container ports 8000 and 8443 | Traefik on `hostNetwork`; a Bucket endpoint inside the cluster for Services; leaving it and documenting it | a pod connecting to its own node's public IP is DNATed by the hostPort to Traefik's pod IP (10.42.x) before k3s's policy filter sees it, so the private-range exclusion refused it: a Service calling a Bucket or any platform hostname failed whenever DNS gave it its own node, always with one Site down (found by `spa-api` on the dev cluster, 2026-11-09). Kubernetes leaves ipBlock behaviour around such rewrites undefined; allowing the ingress controller by selector is the usual answer (Calico, Cilium). The pods gain nothing over the public address: Traefik routes by Host. `hostNetwork` would move Traefik's admin and metrics ports onto the hosts |
| 105 | The customer egress policies (`service-egress`, `job-egress`) leave the nodes' addresses (InternalIP and ExternalIP, /32 and /128) out of the internet and allow them on TCP 80 and 443 only. The Services and Jobs operators list the Nodes on every pass and watch them to start a pass at once when a Node joins, goes or changes its addresses; with no Nodes, a Node without an address or a failed listing, the pass applies and deletes nothing. Their ClusterRoles gain `list` and `watch` on Nodes | a host firewall rule dropping pod traffic to the nodes but for 80 and 443; the node-to-node ports on Tailscale addresses; leaving it, as each port needs a certificate or token | pod traffic leaves with its node's address, so the host firewall, which admits everything between nodes, cannot tell a customer's pod from the platform's: a host rule would also cut off the platform pods that use the Kubernetes API (through the `kubernetes` Service, rewritten to a node's 6443) or kubelet, or need holes that reopen them. Tailscale as the node mesh reverses decision 28. k3s's policy controller has no notion of a node, so the operators supply the addresses, as Cilium's `world` entity leaves out `host` and `remote-node` and Calico users keep node addresses in a GlobalNetworkSet. Planning without the addresses is no fallback: pruning would delete the policy, and a new Project's pods would start without one; the cost is that while any Node has no address (a Node registering), no Service or Job is created, changed or deleted. Only the addresses a Node reports are left out, so a node's every public address must be given to k3s. The watch only wakes the pass, which lists the Nodes itself, so a broken watch costs at most one interval. Before, a Service's pod reached 6443, 10250 and 2379 on every node. Tested on the dev cluster (2026-11-09, with decision 104), the pass run under the Services operator's ServiceAccount: from a pod on each compute node 6443, 10250, 2379, 2380 and 3901 on all three nodes, `10.43.0.1:443` and the metadata endpoint were refused, while a Bucket answered through 443 of either compute node; the same policy without the node addresses left them open; with `list` on Nodes taken away the pass logged the 403 and left the policy as it was |
| 106 | The platform's monitoring is kube-prometheus-stack (Prometheus and Alertmanager once per compute Site, Grafana once), Loki single-binary once per Site, the third Site included (replication factor 3), with its data in a Garage bucket, and Alloy shipping the platform's namespaces' logs; Prometheus's pods may reach each Project's CloudNativePG pods on their metrics ports, nothing else of a Project (NetworkPolicy `database-metrics`) | VictoriaMetrics with VictoriaLogs; Prometheus alone without Grafana and Loki; one instance on the third Site; one instance anywhere; one Loki (its WAL disk is bound to its node, so it cannot move off a dark Site); two Lokis with replication factor 2 (both are needed for every write) or 1 (tested: Loki never forgets the last other member, so a dark Site stopped all writes); two independent Lokis written twice by Alloy (no load on the third Site, but two copies and two datasources); the metrics ports opened in `project-isolation` (every pod of a Project, from every pod in `monitoring`) | the standard stack: CloudNativePG, Traefik and cert-manager ship metrics and rules for it, and most documentation fits; one replica per compute Site keeps alerting through a Site failure; Loki's data in Garage survives a lost pod or Site with three copies, and three Lokis keep logs coming in and queryable while any one Site is dark. This puts a platform workload on the third Site, which decision 24 had kept to etcd and Garage. Costs: up to 1 GiB of RAM for Loki on the third Site, which must be sized for it next to etcd (about 8 GB), and about 1.5 to 2 GB of RAM per compute Site, once for the platform and not per customer, which each Site's spare capacity (decision 19) must hold, and two copies of the metrics |
| 107 | Alerts go by e-mail through SES's SMTP interface with the existing send-only key; the always-firing Watchdog is pinged to healthchecks.io every minute as a dead man's switch | push through ntfy or Telegram; e-mail without a dead man's switch | no new provider for the alerts themselves; without the switch a dark cluster or a dead Alertmanager sends nothing, and silence looks like health. healthchecks.io gets no customer data, only the pings. Costs: e-mail is slow to notice at night; healthchecks.io is one more account (docs/self-hosting.md, section 10) |
| 108 | A restore is a field of creating a Database, `restoreFrom: {databaseId, targetTime?}`, for any Database of the same Project, live or deleted within the retention window; without a target time, the latest point the archive reaches. Memory, storage and Home site are given as for any Database (`oup pg restore` defaults them to a live source's). The API refuses a time before the source's oldest base backup (its ObjectStore's recovery window) or less than 5 minutes before now or the source's deletion. Once the restored Cluster has a ready instance, the restore is recorded as finished and the Cluster is rendered without the recovery bootstrap | a route on the source, `POST …/databases/{id}/restore` (cannot address a deleted source); letting CloudNativePG fail an unreachable time | DigitalOcean's `backup_restore` on create, Fly's `--fork-from`: one route, the same checks and Holds as any create, and decision 60's promise that a deleted Database can be restored is reachable through the API. A restore that could only fail would leave a Database stuck in `provisioning`. Costs: the API reads the ObjectStore (`get` on `objectstores` for the control plane); a deleted source is restored by its id, which only `oup pg delete` prints, since deleted Databases are not listed |
| 109 | Databases' volumes are thick logical volumes from TopoLVM in the volume group `openupstream` on each compute Site, placed through Kubernetes' storage capacity tracking (no scheduler extender), 10 GB of each group spare; on the dev cluster the group is a Hetzner Cloud Volume per compute VM | thin provisioning with an overprovision ratio; local-path on the dev cluster; a loop device on the VM's disk | one Database filling its volume never stops another, and nothing new needs watching; RAM, not disk, fills a node first (decision 1), so thin's density buys little while its full pool would stop every Database on the node. A cloud volume is a real block device, so the dev cluster sets up storage as the servers do. Costs: storage billed but unused still takes disk; about €0.005 an hour per dev session for two volumes. Replaces decision 52's local-path storage |
| 110 | `PATCH …/databases/{id}` takes `memoryMb` (up or down) and `storageGb` (up only); growing either is refused while the Account has a Hold, and with 507 when TopoLVM reports no room; the API reports `resizing` until the Cluster's spec has the row's sizes and no volume is growing. A rolling restart restarts the primary in place after the standby, with a 30 s smart shutdown and PgBouncer's `server_login_retry` at 1 s | storage only; resizing by recreating the Database; switchover (8 s pause, but the primary leaves its Home site); switchover and back; a temporary third instance in the Home site (a full copy per resize) | a volume cannot shrink, and TopoLVM grows one online; memory changes are CloudNativePG's rolling restart; in place keeps the primary where Services expect it, and the shorter shutdown wait cut a resize from 4 to 1.5 minutes with one 12 s write pause (dev cluster, 2026-11-15). The state comes from comparing sizes, so no spec version is needed. Costs: the control plane lists CSIStorageCapacity and PVCs; the room check is racy (two requests can take the same space); a shrunk Database's data must fit its memory's working set; a smaller disk means restoring into a new Database |
| 111 | Storage grows by itself, on by default and without a limit unless the customer sets `maxStorageGb` (`autoGrow: false` turns it off): once a Database's fullest volume is 90% used, a control-plane pass raises `storageGb` by half (at least 1 GB), never past the maximum and by less if the nodes have less room, through the same path as decision 110; not while the Account has a Hold. Usage comes from the platform's Prometheus (`kubelet_volume_stats_*`). The API also checks memory room before accepting a size | off unless set, with a maximum (RDS); +max(10%, 1 GB) at 10% free (RDS's step, scaled down); TopoLVM's pvc-autoresizer (grows PVCs behind CloudNativePG's and the row's back); the kubelet's stats API (needs `nodes/proxy`, which reaches every pod); Postgres sizes over SQL (misses WAL and temp files) | a full disk stops every write, and most customers never set a limit; Supabase grows by half at 90% too, fewer and larger steps than RDS. TopoLVM grows in seconds, so no cooldown is needed. Prometheus already scrapes every volume. The pass also grows the PVCs of a Cluster CloudNativePG stopped for a full disk (it waits for them without growing them), so the control plane may patch PVCs. Costs: storage is a ratchet and, without a limit, a runaway writer grows the bill until the node is full (`DatabaseVolumeFull` alerts); without Prometheus nothing grows; a held Account's Database fills up |
| 112 | (Since decision 124 a single node has Prometheus too: usage is shown and metered there; storage still does not grow by itself.) A single-node dev cluster ([ADR-0004](docs/adr/0004-single-node-dev-cluster.md)): two layouts, `multi-node` (one node per Site) and `single-node` (one node standing in for every Site, development only), recorded once in the ConfigMap `openupstream-system/cluster-layout` by `install-multi-node.sh` or `install-single-node.sh`, which refuse a cluster without a node in each Site or with more than one node; every install step reads the layout. In single-node Garage and Loki keep one copy, a Database runs one instance and one PgBouncer (`layout` in the DatabaseConfig) on k3s's local-path storage instead of TopoLVM, so the API's room check finds no capacity and accepts sizes unchecked, the platform's per-Site components run once, and the node carries the label of `hetzner-fsn1`, so the API and placement stay unchanged. `infra/dev-cluster` installs onto any k3s cluster (`k3s-single-node.sh` sets one machine up over SSH); the Hetzner VM scripts move to `infra/dev-cluster-hetzner`. `dns.sh` reads the compute nodes' addresses from Kubernetes (ExternalIP first), so a home node's private or Tailscale address (`NODE_ADDRESS` in `k3s-single-node.sh`) goes into public DNS; the domains are required in single-node and may be names inside a bunny.net zone, certificates come from Let's Encrypt through DNS-01, by default from the production issuer, an exception to decision 70 | three VMs on one machine (manifests unchanged); TopoLVM on a single node from the free space of the OS's volume group (needs a room check per existing Site, and Database volumes next to the root volume); k3d (three k3s nodes as containers); detecting the layout from the node count; a local CA with sslip.io or a home DNS name; the API refusing `ovh-lim` in single-node | the three-node rules only protect against a machine failing when the nodes are different machines: three VMs on one box need about 24 GB of RAM and two or three copies of every byte for redundancy that is not there, while one node with one copy needs about a third of that. k3d shares that cost and may not run gVisor inside a container. A recorded layout cannot flip when a three-node cluster has temporarily lost two nodes, and a step run again on its own (e.g. `platform.sh` for `CLI_CLIENT_ID`) installs the same way. Public DNS pointing at a private address and DNS-01 give real certificates with no inbound connection and no CA to trust. Costs: no failover and no test of placement or the third Site on such a cluster, Database sizes neither reserved nor checked, storage growth (decision 110) never completing and automatic growth (decision 111) off there, downtime when its only Database instance restarts, no certificates for custom domains (HTTP-01 cannot reach it), and routers with DNS rebinding protection need an exception for the domain. Tested on a Minisforum mini PC on Ubuntu 26.04 reached over Tailscale (2026-11-15, k3s 1.36): 21 pods running, one instance per platform Database, DNS pointing at the Tailscale address, the API and madAuth answering with Let's Encrypt certificates (after decision 113) |
| 113 | On nodes with AppArmor, containers run under our copy of containerd's profile `cri-containerd.apparmor.d` (`infra/apparmor`), containerd 2.3's own plus signal and ptrace rules for the stacked label `cri-containerd.apparmor.d//&unconfined`; installed into `/etc/apparmor.d` and loaded before k3s by `k3s-single-node.sh`, on every run. Delete it once k3s ships containerd's fix (containerd #14487) | `kernel.apparmor_restrict_unprivileged_unconfined=0`; the Databases' pods `Unconfined`; staying on Ubuntu 24.04 | Ubuntu 26.04 stacks every container's profile on `unconfined`, and containerd's rules name only the unstacked label, so a container's processes cannot signal each other: on the Minisforum (2026-11-15) every Postgres failed with `could not signal for checkpoint: Permission denied` and stayed in recovery. The copy fixes exactly that rule, as upstream does, and keeps the containers confined; the sysctl would switch off Ubuntu's restriction on unprivileged user namespaces for every program on the machine, and `Unconfined` drops AppArmor from the Databases. Costs: our copy lags behind changes to containerd's profile until it is deleted, and it must be in place before k3s first starts. The Hetzner dev cluster runs Ubuntu 24.04 and does not need it yet; production nodes on 26.04 will |
| 114 | Metering: a control-plane pass turns every completed hour into one usage event per Resource and unit. CPU seconds of all Resources come from the CPU agent through Prometheus (decision 115), memory of Services from running pods' requests and of Jobs from each run's request × run time (kube-state-metrics); egress from Traefik's per-rule response bytes, with an IngressRoute per Domain and Resource so each rule's metric names its Resource; Databases' memory and storage from their rows; Buckets' storage from Garage. Jobs are Resources of their own. Metered hours are listed; the billing service reads monthly sums per Project, Resource and unit | the Kubernetes metrics API (a sampled rate, not a counter); daily events; raw events to the billing service; one IngressRoute per Domain and the rules' hashes recomputed by metering (reproduces Traefik's internal naming; a Route deleted before its hour is metered is lost) | the counters are already scraped and exact over an hour; hourly events bill a Resource for the part of an hour it lived. Costs: billing depends on Prometheus (an outage longer than 14 days loses revenue, never overcharges); a Bucket's bytes are those at metering time, not the hour's average; a Project purged before its last hours are metered is not billed for them |
| 115 | CPU seconds come from our own CPU agent, a DaemonSet on the compute nodes that reads each pod's total from its cgroup every second and when its last process exits (`cgroup.events`), and serves it to Prometheus, kept 15 minutes after the pod ended; metering bills a pod's total at the hour's end less at the previous hour's end | cAdvisor's counter (misses up to 30 s at each end of a pod's life and all of a run shorter than a scrape); Jobs' CPU as reservation × run time (Fargate, Cloud Run, Fly.io bill containers that way); measured CPU with short runs free | the kernel counts every pod's CPU exactly, but the count goes with the cgroup half a second after the pod ends; reading it then makes measured CPU exact for every Resource, short Job runs included, with one meaning for all. Costs: a component of our own on every compute node (read-only cgroup mount, listing its node's pods), and it races the cgroup's removal: if it loses, at most about a second of CPU is missing |
| 116 | The dashboard is static files that call the API from the browser, authenticated by madAuth's session cookie, which the API takes as a session token only; the SDK takes `session: 'cookie'` in place of a token. How the cookie reaches the API, and how a request forged by another site is told apart, is decision 120 (first decided as a cookie for the whole platform domain, sent to `api.<platform domain>` with CORS and an `Origin` check) | the dashboard's server reading the cookie and calling the API with it as Bearer (a backend-for-frontend); an OIDC access token held by the page's JavaScript, like `oup`'s | madAuth's session cookie is HttpOnly, so a page cannot send it as Bearer. No Node server to run for the dashboard: it can be served like any static site, and log streams (#103) go straight to the API. No token a script could read (XSS), and a session carries the e-mail address that creating an Account needs, which an access token does not. Cost: a script injected into the dashboard itself, or a browser extension, can still call the API as the Member |
| 117 | Production servers are ordered by hand in the providers' consoles and set up by shell scripts over SSH: the platform install is the dev cluster's (`infra/dev-cluster/install-multi-node.sh`), and the node setup (host firewall, AppArmor profile, gVisor, volume group, k3s) is to be one script used for production and by `infra/dev-cluster-hetzner/up.sh`, not written yet; no Terraform, `infra/terraform` is removed. This replaces the Terraform setups that ADR-0002's consequences and `infra/README.md` named | Terraform for the OVHcloud server order and the bunny.net records, scripts for the nodes | Hetzner's dedicated servers and netcup have no official provider, so Terraform would manage one server order and DNS records that `dns.sh` already writes from the nodes' addresses, at the price of a state file with secrets kept outside the cluster and a second DNS path the dev cluster does not test. One path means every dev session tests the production install. The backup bucket is made by hand (`docs/self-hosting.md`, section 4), the DNS records and health checks by `dns.sh`. Costs: nothing reports a firewall rule or record changed by hand, so the scripts must be safe to run again |
| 118 | The two NVMe disks of each compute server are mirrored by software RAID 1 in two parts: a small one for the operating system and the rest, left empty by the installer, as the volume group `openupstream` (`infra/topolvm/vgcreate.sh /dev/md…`) | both disks in the volume group without RAID | a dead disk costs a disk swap; without RAID it takes down every Database instance on it, their primaries fail over and each instance is rebuilt from the other Site while its Database runs on one copy. Two parts keep the system's disk use and the Databases' apart, and a default install would give the whole mirror to `/`. Costs: half the room for Databases, and changing it later means reinstalling the node |
| 119 | The production servers are ordered one after another: OVHcloud first on a monthly term, to measure FSN1↔Limburg RTT with WireGuard over a few days, then Hetzner and netcup. The OVHcloud server is a RISE-2 or RISE-S with 64 GB and two NVMe disks; the order waits until one is in stock in Limburg | all three at once; what Limburg had in stock on 2026-11-15: RISE-1 (32 GB only), Rise-Game-1 with 64 GB (game range, its DDoS filter in front of WireGuard's UDP), RISE-2 with 128 GB (about €53/month more), ADVANCE-2 (about €100/month more); another provider for this Site, checked the same day: IONOS (64 GB for €69/month only with a 4-core CPU from 2017 and hardware RAID, 8 cores only on a 12-month term or for €171), webtropia in Düsseldorf (from €160), Cherry Servers in Frankfurt (from $186), Contabo (out of stock) | if Limburg's latency does not hold, only one month of one server is lost and ADR-0002 can still change; both compute Sites get the same RAM, since each must carry the other's Services (decision 33's cost stays). Another provider would also need its latency measured, a new ADR and the Site's name `ovh-lim` changed. Costs: production waits for OVHcloud's stock, for which it gives no date |
| 120 | (For the hosted service that host is `console.openupstream.com` since decision 123.) The API is under `/api` of the platform's host, `https://openupstream.com/api/v1/…`, for the dashboard, `oup` and the SDK alike; `api.openupstream.com` is gone, which supersedes that part of decision 67. Traefik routes `/api/*` to the control plane and strips the prefix, so its routes still start at `/v1`. madAuth's session cookie stays host-only (no `COOKIE_DOMAIN`), and the API reads it only on requests with `Sec-Fetch-Site: same-origin`; the API sets no CORS headers | the cookie for the whole platform domain with CORS and an `Origin` check (decision 116 as first built); the API at both `api.` and `/api`; madAuth also served on `api.` with a hand-over of the session by a one-time code after every sign-in and renewal; a short-lived access token from madAuth for the page; the control plane mounted under `/api` itself | browsers know only a host-only cookie or one for a domain and all its subdomains: the latter sent production's session token to every host under `openupstream.com`, dev clusters at `dev.openupstream.com` included, which could replay it. Host-only, no subdomain ever sees it; same origin needs no CORS and no preflights; one address for every client, one DNS record and one certificate name fewer per installation. A page cannot set `Sec-Fetch-Site`, and every current browser sends it (Safari since 16.4), to HTTPS and localhost origins only; without it the answer is 401, so the dashboard needs HTTPS, as madAuth does in production. Stripping at the ingress leaves the control plane the same locally, in tests and on its internal port. Costs: the paths `/api`, `/auth` and `/.well-known` are taken on the dashboard's host, and the API shares that host's ingress, apart only by path and its own rate limit; `Location` headers name `/v1/…` without the prefix; SDK 0.2 and `oup` 0.1 default to the old host and need `baseUrl` or `OUP_API_URL` |
| 121 | Every pod of a Service or Job may write 2 GiB to its container's filesystem and logs: an `ephemeral-storage` limit of 2 GiB with a request of 100 MiB, the same for all, not billed and not a field of the API | the limit also as the request (reserved: the scheduler never promises more disk than a node has); a `diskMb` field per Service and Job; no limit, relying on the kubelet's eviction under disk pressure | without a limit one customer's container could fill a node's system disk, and the kubelet then evicts other customers' pods. DigitalOcean App Platform fixes 4 GiB, Azure Container Apps 1 to 8 GiB by vCPU, Cloud Run counts files against memory. gVisor keeps a container's writes in a file in the container's root on the host, which the kubelet counts: a gVisor pod that wrote 2.4 GB was evicted within seconds (dev cluster, 2026-11-15). A request must be given, since Kubernetes takes the limit as the request otherwise, and reserving 2 GiB per pod would cap a node at its system disk's size / 2 GiB, a disk decision 118 keeps small. Costs: not reserved, so many pods filling up at once can still put a node under disk pressure, where the kubelet evicts the pods furthest above their request first; a customer who needs more scratch space has no setting for it; an evicted pod whose process exits 0 on the kill is reported as succeeded (seen on that test's pod), so such a Job run looks successful |
| 122 | Every pod of a Service or Job is limited to 300 Mbit/s each way by the annotations `kubernetes.io/{ingress,egress}-bandwidth`, which the `bandwidth` plugin of k3s's CNI enforces, and a bandwidth agent, a DaemonSet on the compute nodes from the operators' image, sets each bucket's burst to 0.1 s of its limit and, while the node's uplink is above 80% of its speed, lowers all customer pods' limits to the fair share (max-min: pods below it keep their traffic, the others split the rest, at least 10 Mbit/s) | 100 Mbit/s fixed without an agent; egress only; a limit that grows with the CPU; the fixed limit alone; a fair queue (cake, fq_codel) on the uplink instead of an agent; Cilium's bandwidth manager | one pod could fill a node's uplink for everyone on it. The annotation is all that k3s needs and holds from a pod's first packet, also under gVisor, but the CNI reads it once, when the pod starts, and containerd asks for the largest burst there is: a pod at 300 Mbit/s received 2.1 Gbit/s for two seconds and sent above its limit for as long as measured (dev cluster, 2026-11-15); with the burst set by hand it held 296 Mbit/s both ways from the first second. 300 is generous for a web app, and four pods at it fill 1 Gbit/s, so the limit must come down under load: a fair queue shares by connection, not by customer, and Cilium would replace flannel and k3s's policy controller for a limit that is fixed per pod as well. None of Azure Container Apps, Fargate, Cloud Run, DigitalOcean App Platform or Fly.io documents a limit per container. Costs: a component of our own on every compute node that runs as root with NET_ADMIN on the node's network, which can change the node's whole network configuration (decision 90 installed gVisor by script to leave nothing privileged running; this is the one exception, with no API access, no port and a read-only filesystem); a pod started while the agent is down has the 512 MB burst until it is back, and a lowered limit stays until then; the uplink's speed is one setting for all nodes where the interfaces do not report it (`UPLINK_MBIT` of `platform.sh`), and without one nothing is lowered; a pod's bucket counts all its traffic, so what stays on the node (to a Pooler, from Traefik) is limited with the rest while the uplink is full, whoever fills it; limiting what a pod receives does not stop the packets from arriving at the node |
| 123 | The dashboard is served on every cluster by an nginx image of its own (`ghcr.io/openupstream/dashboard`: the static export, built per commit by the Images workflow, installed by `platform.sh`) at every path of the platform domain that madAuth and the API do not have. The platform domain of the hosted service is `console.openupstream.com`, which is also the default API address of the SDK and `oup` (`https://console.openupstream.com/api`, SDK 0.3.1 and CLI 0.2.1). `openupstream.com` is the product's welcome page and never the dashboard: the waitlist moves there as a host of its own (`WAITLIST_DOMAIN`, with its own DNS record and certificate), required and different from the platform domain whenever `SIGNUP=closed`. Supersedes the hosted host of decisions 67 and 120 and the waitlist's place in decision 86; settles the former Open question 22 | a Bucket of the platform Project behind a Domain, deployed with `oup site deploy`; the control plane serving the files on a further port; the dashboard under `/app` next to the waitlist at `/`; the waitlist moved to `/waitlist` with the dashboard at `/` | the sign-in page must not depend on the product it is the door to: a Bucket needs Garage, the Routes operator and a signed-in deploy before anyone can sign in, and the control plane serving it would restart the API for every dashboard change and take the page down with it. nginx with read-only files needs nothing and is versioned with the commit like the other platform images; the same files can move to a Bucket later. A welcome page and a console are different things with different visitors, so they get different hosts instead of sharing paths: no priorities between routes, no `/app` in every address, and an installation that is not ours simply has no welcome page. Cost: one more image and two more pods; SDK 0.3.0 and CLI 0.2.0, published hours earlier, default to an address that never served the API |
| 124 | The API says what a Project's Resources use now: `GET /v1/projects/{id}/usage` lists each Resource with its instances (pods under our own word: Site, state, restarts, start) and their current CPU, memory and, for Databases, disk, next to what was given; the SDK has `getUsage` (0.4.0). The figures come from the platform's Prometheus, which is therefore part of every install, a single node included: `monitoring.sh` runs before `platform.sh` in both install scripts and, without `ALERT_EMAIL`, sends no alerts and needs no SES key or healthchecks.io URL. `DATABASE_VOLUMES=shared` (set on a single node) tells the control plane that Database volumes are directories of the node's disk: storage auto-grow stays off there and a Database's disk use is read from Postgres (databases plus WAL) instead of the volume. Changes decision 112, where a single node had no Prometheus and recorded no usage | the Kubernetes metrics API (metrics-server, in every k3s) for CPU and memory, with disk only where Prometheus exists; our own node agent reading memory and volumes too; metered usage per month as what the dashboard shows; totals per Resource without instances | one source for what is shown, billed and grown on, so the dashboard and the invoice cannot disagree about CPU, and history for graphs is already kept (15 days). metrics-server has no disk and no history and would be a second source; an agent of our own is the most code and needs the kubelet's mounts. A customer asks "which replica is busy or restarting", which totals do not answer. Volume usage on local-path is the whole disk's (25 GB for an empty Database on the single-node dev cluster), hence Postgres's own figures there, which leave out temporary files. Costs: Prometheus, about 1 to 1.5 GB of RAM, on every cluster, self-hosted ones too; without it the answer lists instances and measures nothing; CPU is a two-minute average with scrapes every 30 s, so a new pod shows no CPU for its first minute; the control plane asks Prometheus on every request (three queries per Project) |
| 125 | `oup` is documented on the dashboard's `/cli` page, readable without signing in. Its text is the part of `cli/README.md` between two marker comments, read when the dashboard is built and shown by a small parser of our own (paragraphs, list items, code); a test fails when that part uses anything else. The browser puts the installation's own API address into the sign-in command when it is not `oup`'s default | a documentation site of its own (Docusaurus, VitePress and the like, as Fly.io, Render and Railway have); linking to the README on GitHub or npm; a page written by hand in the dashboard; a Markdown library (`react-markdown`, `marked`) | the page comes with every installation and knows its address, which a public site and the README cannot: `oup login` without `--api` signs in to the hosted service. One text, so the README, npm's page and the dashboard cannot disagree. The README uses three kinds of Markdown, which is 60 lines to parse and no dependency in the browser bundle. Costs: the README's wording now also serves customers, and its pointers to decisions are cut from the page; it names the hosted service's Sites and a standby in the other one, also on an installation with one node; anything beyond the three kinds needs the parser extended; a single long page, with no search and no versions per `oup` release |
| 126 | Proposed, not built ([ADR-0005](docs/adr/0005-database-access-from-outside.md)): a Member reaches a Database from their own machine with `oup pg proxy`, which listens on a local port and carries connections over a WebSocket through Traefik on port 443, at `pg-<project id>.<customer domain>`, to a forwarder pod in the Project's namespace, one per Project, which copies bytes to the Database: its Pooler at `read` and `write`, its primary at `owner`, so that migration tools' advisory locks work. Traefik asks the control plane whether the caller's token may reach the Project before it forwards. Each Member, and each API key, gets Postgres roles of their own per Database, whose passwords the control plane keeps encrypted and returns to `oup`, one per access level they use (`--access read`, the default, `write` or `owner`, which acts as `app`: a member of `app` whose default role `oup` sets to `app` as the role itself, so what a migration creates belongs to `app` and no superuser is needed); every Member picks their own level until there are Member roles (Open question 9). The `app` password is still never returned (decision 61) | a public endpoint per Database (Traefik TCP with TLS SNI); Tailscale; a WireGuard gateway per Project (wireproxy) | no new port on the nodes and no Postgres login facing the internet; nothing to install besides `oup`, which as a Node package would have to ship a WireGuard binary; the forwarder is a pod of the Project, so `project-isolation` covers it unchanged. Hosted tools that cannot run `oup` still need the public endpoint (Open question 13) |
| 127 | The dashboard deploys Services from public images only: its form has no fields for a private registry's user and password, which stay with `oup service deploy --registry-password-stdin` and the API. A Service that has credentials shows that it does, and the dashboard changes and redeploys it like any other | a user and a password field in the form (Render, Railway and Fly.io's dashboards take registry credentials this way); a registry credential stored once per Project and picked in the form | the dashboard's promise is that its JavaScript never holds a credential (#116): a registry password typed into the page would be the first secret a script injected there could read, for a case `oup` already covers without the value ever being an argument or on screen. Credentials per Project are the better answer and a change of the API, so they are a decision of their own when asked for. Cost: a customer with a private image needs `oup` for the first deploy and for every change of the credentials |
| 128 | The dashboard does not show a Bucket's key. Its Project page reads Buckets from the list call alone, which leaves the key out, so the secret never reaches the browser; the card shows the S3 endpoint and where Routes serve the Bucket. An S3 client's key comes from the API (`GET /v1/projects/{id}/buckets/{id}`), and `oup site deploy` fetches it itself | a "Show access" button that fetches endpoint, key id and secret for one Bucket (Cloudflare R2 and Hetzner Object Storage show an S3 secret once, when it is created) | the same promise as decision 127: the dashboard's JavaScript holds no credential (#116), and a Bucket's key may write. Cost: a Member who wants the key for an S3 client has to call the API, since `oup` has no command for it yet |

## Open questions

Undecided points that block or shape the design. Each one moves to the
Decisions table once it is settled.

1. **Checks before ordering servers.** Measure FSN1↔Limburg RTT with
   WireGuard over a few days once the OVHcloud server is there (decision
   119); check netcup's traffic allowance (not on its product pages);
   check Hetzner's Falkenstein stock and what "LTD" means (shown only in
   Robot). Checked 2026-11-15: OVHcloud's order page names the German
   location "Deutschland - Limburg". Its stock can be read without an
   account: `GET https://eu.api.ovh.com/v1/dedicated/server/datacenter/availabilities?datacenters=fra`
   (`fra` is Limburg; plan codes `24rise02-v2` and `25rises01-v2`).
2. **Fewer slow failovers, less dependence on bunny.net.** Chrome and
   Firefox switch addresses at once only when a Site refuses connections.
   Can partial failures be made to refuse instead of time out (host
   firewalls that reject rather than drop on 80/443 when Traefik is down)?
   A Site that goes fully dark still waits for the health check and the
   TTL, 2–3 minutes at worst; to measure: whether reloading the page gets
   there sooner (probably not, the cached answer is reused).
   - **Preferred direction, after v1:** a front in front of both Sites
     whose address does not die with a Site: a Hetzner Load Balancer in
     Nuremberg (`nbg1`, not Falkenstein, so one location outage cannot take
     the front and `hetzner-fsn1` together) forwards TCP with PROXY protocol
     to a pair of proxy VMs (HAProxy in TCP mode, TLS passed through), which
     forward to Traefik in both Sites, retrying the other Site when a
     connection fails. Hetzner's Load Balancer only reaches Hetzner servers,
     so the proxy VMs are what reach `ovh-lim`. About €15/month. A Site that
     fails or reboots then costs clients about a second, a dead proxy VM a
     few health checks; certificates and plaintext stay ours. Costs: one
     more component to run, a few ms of extra hop, Traefik must accept PROXY
     protocol from the proxies only, and the "accepts connections but is
     broken" case still needs the proxies to health-check a real path.
   - **Still open with it:** if the front's location fails, clients need DNS
     failover to a second front at another provider, so DNS failover stays,
     only for that rare case. And bunny.net remains the single DNS
     provider; options: a second provider with its own health checks (e.g.
     Gcore, every 10 s only on its top tier, 60 s below) listed alongside bunny.net, or
     an own health watcher outside the Sites writing records to two plain
     DNS providers (the alternative decision 32 turned down).
   - **Considered and set aside:** anycast with an own /24 and ASN (about
     €150/month plus BGP from providers that offer it; as far as we know,
     not yet checked with them, Hetzner, OVHcloud and netcup do not for our
     server types); AWS Global Accelerator
     (anycast, but endpoints only in AWS) and Cloudflare Spectrum (US
     company in the path); a CDN, which terminates TLS for every customer
     domain (decision 34); hardware load balancers (own hardware, a
     non-goal); a provider's managed load balancer alone (each only reaches
     its own provider's servers).
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
   access is not decided. They would also limit the access level a Member
   may pick for a Database (decision 126).
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
    Services reach a Database. Decision 126 proposes `oup pg proxy` for a
    Member's own machine; it is not built, and
    [ADR-0005](docs/adr/0005-database-access-from-outside.md) lists what a
    dev cluster session has to check first (a role added later by
    CloudNativePG, a password login at the primary, the route at the
    Project's host, long-lived WebSockets and their metering, gVisor, an
    API key's id from madAuth). Still open beyond it:
    clients that cannot run `oup`, such as a hosted BI tool, need a public
    endpoint (Traefik TCP routing with TLS SNI, Postgres 17 direct SSL, its
    certificates); session features (`LISTEN`, advisory locks) reach only
    the `owner` level, which goes past the Pooler; and who pays for the forwarder pod and whether
    a Hold removes it.
14. ~~**Mail for madAuth.**~~ Settled by decision 66: Amazon SES.
15. **madAuth's keys.** With `MADAUTH_KEY_SERVICE=local` the signing key is
    a Kubernetes Secret and in the process's memory; madAuth's alternative,
    AWS KMS, means an AWS dependency. And until the first admin exists,
    madAuth logs a setup token, which Loki collects and keeps 14 days.
16. **Sign-up for those who run openupstream themselves.** The hosted
    service lets anyone sign up and requires a payment method (decision 65),
    closed for now behind a waitlist (decision 86). Without a billing
    service nothing is held (decision 78), so a self-hosted installation
    needs no payment method. Sign-up can be closed with an allow-list of
    addresses and domains (`SIGNUP=closed`, `SIGNUP_ALLOW`, decision 86);
    invitations are not there yet.
17. **The bunny.net API key in the cluster.** cert-manager's DNS-01 webhook
    needs it, and bunny.net has one key per account with full access (no
    DNS-only key, checked 2026-10-18): whoever reads the Secret
    `cert-manager/bunny-api` controls all our DNS. Options: a separate
    bunny.net account that holds only the zones cert-manager writes to, or
    delegating `_acme-challenge` to such a zone.
18. **Billing rules with Mollie and lexoffice** (in the billing service,
    decision 77).
    - ~~How the billing service reads usage events~~: settled by decision
      114, `GET /internal/v1/accounts/{id}/usage?month=`.
    - Small amounts: a month of an idle Database can cost less than the
      transaction fee or Mollie's minimum; carry it over, or a minimum
      charge.
    - Mollie's maximum per recurring payment against an unusually large
      month.
    - How failed and reversed payments are retried and reminded, and after
      how many days an Account is suspended.
    - Which lexoffice tax types cover EU business customers (reverse charge)
      and EU consumers (OSS).
19. **Bucket access for Services and Jobs.** A Service that uses a Bucket
    gets its endpoint and key only by the Account copying them into Secrets
    (`spa-api` does, decision 100), while Databases are bound without a
    step (decision 97). Options: the same automatic binding
    (`BUCKET_<NAME>_…` for every Bucket of the Project, read from Garage by
    the control plane), an explicit binding per Service, or keeping the
    copy. A binding would put Bucket secrets into `project-secrets` or a
    Secret of their own, which the control plane must keep in step when a
    Bucket's key is replaced.
20. ~~**Customer pods reach the nodes' own ports.**~~ Settled by decision
    105: the egress policies leave the nodes' addresses out but for 80 and
    443.
21. ~~**Capacity beyond storage.**~~ Settled with decision 111: the API
    also checks memory before accepting a size, and a volume grow that
    fails anyway fires `DatabaseVolumeResizeFailed`.
23. **What an idle Service reserves and what it pays.** Requests equal
    limits for memory and CPU (decision 93), so an idle Service holds its
    configured memory and CPU on the node. Memory is billed as configured,
    but CPU is billed as measured (decision 115): a Service set to 2 CPUs
    that stays idle blocks two cores and pays for almost none. To settle
    before the unit prices are set. Options, none evaluated yet:
    - A CPU request below the limit, so cores are overcommitted. Costs:
      no guaranteed CPU when many Services are busy at once.
    - A CPU request of half the limit, with the load spread evenly over
      both compute Sites: each node is full by limits and half full by
      requests, so every Service has its configured CPU while both Sites
      are up, and when one is down all pods fit on the other and share its
      CPU in proportion to their requests, at least half each. Today a
      failed Site's pods would stay pending if both nodes were full by
      requests. Needs the Home sites of new Projects alternated, since
      single-replica Services run in their Databases' Home site
      (Falkenstein by default). Costs: memory still has to fit on one
      node, so this doubles CPU capacity only; an idle Service still
      holds half its CPU; the promise becomes "half the CPU during a Site
      outage", which is when many pods start at once; a request below
      its limit also moves a Service's pods from Kubernetes' Guaranteed
      to its Burstable QoS class, so they rank before Databases when a
      node runs out of memory and are the pods swap would apply to (next
      but one option). Tested on the dev cluster (2026-11-15, k3s 1.36,
      4-vCPU nodes, plain Deployments without the platform): three busy
      gVisor pods per compute Site with a request of 500m and a limit of
      1 CPU; after `ovh-lim` was powered off its three pods ran on
      `hetzner-fsn1` within 80 s of the command, each pod's throughput there fell
      to about two thirds (six pods on four cores) and a fixed piece of
      start-up work took 9.4 s instead of 5.5 s. With requests equal to
      limits the three pods stayed pending (`Insufficient cpu`). Not
      tested: Databases and real Services on the same node.
    - A memory request below the limit. Costs: without swap a full node
      means evictions and OOM kills, on nodes that also run Databases;
      metering reads memory from the pods' requests (decision 114) and
      would have to read the limit.
    - The same with swap on the nodes' disks (NVMe on the OVHcloud
      server, decision 119; the Hetzner server is not chosen yet), so the
      kernel moves
      pages an idle Service has not touched to disk and a full node gets
      slow instead of killing pods. The first request after a pause pages
      them back in, without an activator in the request path. Databases
      keep requests equal to limits and are not swapped. Costs: the
      promise becomes "slower after idling"; swap holds customer data and
      Secrets, so it must be encrypted; when a Site is down many Services
      want their memory back on a node that is already full, and it may
      thrash, so the memory of the Services expected to be active must
      still fit on one node. Tested on the dev cluster (2026-11-15, k3s
      1.36, one 8 GB node with an 8 GB swap file on the VM's disk, the
      kubelet with `failSwapOn: false` and `swapBehavior: LimitedSwap`
      in `kubelet.conf.d`, pods with a request of 256 MiB and a limit of
      1 GiB that hold 600 MB):
      - The host swaps a gVisor sandbox's memory: `memory.reclaim` on the
        pod's cgroup moved all 600 MB to swap in 1.4 s, and reading it
        all again took 7.4 s, 50 ms once it was back in memory. Under
        runc the same took 3.0 s for the 284 MB that were swapped.
      - Kubernetes' swap limit does not hold under gVisor. A runc
        container got `memory.swap.max` in proportion to its memory
        request (284 MB here, so swap as large as memory allows a pod
        about its request), but a gVisor pod's memory is counted in the
        sandbox's cgroup, where the limit is `max`: it swaps without a
        limit of its own. A limit would have to be ours, on the pod's
        cgroup.
      - A node with more in use than it has memory stayed up: 14 such
        gVisor pods (8.4 GB on 7.7 GB, 2.9 GB of it in swap) all ran,
        with no OOM kill, no eviction and no `MemoryPressure`. When all
        read their memory at once, those in memory took 50–230 ms and
        those in swap up to 14 s (most 10–14 s).
      Not tested: the servers' NVMe (the page-in rate of about 80 MB/s
      is that of a cloud VM's disk), encrypted swap, Databases on the
      same node, a real Service's latency instead of a full read, and
      whether the kernel swaps idle pods by itself early enough or the
      platform has to call `memory.reclaim`.
    - Billing reserved instead of measured CPU while a pod runs, as
      Fargate and Fly.io do (Cloud Run only with instance-based billing;
      by default it bills CPU while a request is handled). Contradicts
      decision 115.
    - A price per memory GB-h that carries the reserved CPU, with a cap on
      CPU per GB of memory.
    - Scale-to-zero for Services with a port: an activator in the request
      path of both compute Sites that holds the first request and scales
      0 to 1 (candidates: Sablier, KEDA's HTTP add-on, Knative Serving),
      an idle timeout per Service, and a measured cold start under gVisor.
      Frees memory as well as CPU; workers without a port stay at one
      replica. Databases stay always on (Non-goals).

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
   Accounts created through the API (2026-10-17). Storage that grows by
   itself (decision 111), tested on the dev cluster (2026-11-15) with
   Prometheus and the alerts installed: a 1 GB Database filled to 93% was
   raised to 2 GB within one pass; one with auto-grow off and one at its
   maximum stayed and fired `DatabaseVolumeFull`; a create larger than a
   node's free memory was refused with 507. The run found that a volume
   that filled up faster than a pass stops Postgres and CloudNativePG
   never grows its PVCs (fixed: the pass does); with that, a full
   Database resized through the API was back in a minute, one whose
   maximum was raised in five (Kubernetes' crash-loop back-off). A grow
   TopoLVM could not carry out fired `DatabaseVolumeResizeFailed`, which
   first used a PVC condition metric kube-state-metrics does not have
   (fixed: it compares the sizes). TopoLVM and resizing (decisions 109 and 110),
   tested on the dev cluster (2026-11-15): every Database instance got a
   logical volume of its size in its node's volume group, the third Site
   none; `oup pg resize` grew 2 to 5 to 8 GB online without restarting
   Postgres and refused shrinking; a memory resize paused writes through
   PgBouncer once for 11 s and kept the primary in its Home site; a size
   beyond the free space was refused with 507. The run found three things,
   fixed: the API accepted sizes TopoLVM had no room for, said `ready`
   before every volume had grown, and a memory resize took 4 minutes with
   a 16 s pause under CloudNativePG's and PgBouncer's defaults. Done
   since: restore through the API and the `oup pg` commands (decision 108).
   Tested on the dev cluster (2026-11-10) with `oup pg`: a restore to a
   time between two rows held only the first, one to the latest point both
   (once their WAL was archived), one of the deleted source by its id
   both; a time before the first base backup, less than 5 minutes ago or
   after the deletion was refused with the earliest or latest time. Each
   restore was ready in 1 to 1.5 minutes and archived into its own folder.
   The run found that a restored Database could not fail over once the
   source's ObjectStore was gone (fixed: the recovery bootstrap is dropped
   once the restore has finished); with the fix, two restored Databases
   failed over within 10 s without it; `oup login`
   (2026-10-31, #87), tested on the dev cluster with madAuth 0.7.0: the
   code approved through madAuth's API, the tokens stored with mode 600,
   a refresh that rotated the refresh token, a logout that ended it, and
   `OUP_API_KEY`. Public hostnames for
   madAuth and the API come with step 2, together with SES and the
   payment-method gate that open sign-up needs.
2. Object storage and static sites: Garage, routing table, Traefik,
   cert-manager. With Traefik come the public hostnames of the API and
   madAuth, and so open sign-up: this step also brings the sidecar's SES
   sender (#66) and the payment-method gate, a Mollie customer and mandate
   per Account checked before the first Resource (#65, #74, #75). Done on
   the dev cluster (2026-10-19): Traefik, cert-manager with DNS-01 on
   bunny.net, health-checked DNS for both Sites, the API and madAuth on
   public HTTPS hostnames, SES; Holds with their internal API routes, the
   open half of the gate (2026-10-20, #78); the private billing service
   with the Mollie mandate, the other half (2026-10-20, #75–77): a card
   first payment in Mollie's test mode, its webhook, the mandate lifting
   the Hold `payment-method` and the €0.01 refunded. Garage and Buckets
   (2026-10-20, #81–83): Garage on all three Sites, Buckets created and
   deleted through the API with a key of their own, reached at
   `https://<bucket>.s3.dev.openupstream.app`. Static sites at Projects'
   default hostnames (2026-10-31, #84): the routing table with Routes to
   Buckets, SPA fallback, the Routes operator. Custom domains (2026-10-31,
   #85): claim, TXT proof, a certificate of their own through HTTP-01,
   issued within 30 s of the first Route and served in both compute Sites;
   deleting the Domain removed its Certificate and Secret in the next pass.
   Closed sign-up and the waitlist on `openupstream.com` (a host of its
   own since decision 123) until the gate
   before the first invoice is passed (#86): the control plane's page and
   the sidecar's switch. On the dev cluster (2026-10-31): other addresses
   refused with the waitlist message, an allowed `@domain` signed up, the
   page behind madAuth's routes, its e-mail sent through SES, confirm and
   remove through the public route, form posts limited to 5 a minute per
   IP; `SIGNUP=open` and a restart removed the page and opened sign-up.
   `oup site deploy` with its cache headers (2026-10-31, #88): a second
   deploy uploaded nothing, a new build only its changed files with the
   index last and deleted the old bundle, and the served headers matched.
   Left: the approval page
   for `oup login` at madAuth's `loginUrl`, which the dashboard has
   (decision 116; run locally 2026-11-15 against madAuth 0.7.0 and the
   control plane: sign-up with the code from the e-mail, the session
   cookie accepted by the API from the dashboard's origin, an Account,
   Projects created and deleted), served on a cluster by its own
   nginx image (decision 123; on the single-node dev cluster 2026-11-15:
   the page at the platform domain with madAuth and the API beside it; on
   the Hetzner dev cluster the same day with `SIGNUP=closed`: a dashboard
   replica in each compute Site, the waitlist at
   `waitlist.dev.openupstream.com` with its own record and certificate, its
   confirmation link on that host, a refused sign-up pointing there, and
   `down.sh` removing the record), and reaches the API under `/api` of its own
   host (decision 120; on the Hetzner dev cluster 2026-11-15: the route
   with the prefix stripped on both compute nodes, the cookie accepted
   only with `Sec-Fetch-Site: same-origin`, `oup` with an API key); the
   production DNS zones.
3. Containers, Service mode. Done on the dev cluster (2026-10-31): the
   NetworkPolicy `project-isolation` in every Project namespace (#89),
   gVisor on the compute nodes and the RuntimeClass `gvisor` (#90),
   Secrets through the API, written into each Project's namespace by the
   control plane (#91), Services through the API pinned to the digest of
   their tag (#92), run by the Services operator and served through Routes
   (#93). Tested: `traefik/whoami:v1.10` from Docker Hub created through the
   API, pinned to `sha256:1699d99c…`, running under `runsc` and answering
   at the Project's default hostname through Traefik in the other Site,
   with its name from a Secret; a new Secret value rolled it, two replicas
   ran one per Site, a redeploy kept the digest, deleting it while routed
   was refused and afterwards both operators removed its objects. A pod in
   another namespace reached none of the Project's pods, madAuth or the
   internal API; a Service's pod reached its own namespace, DNS and the
   internet, not the control plane, Garage's admin API or the metadata
   endpoint. The test found that the operators' Kubernetes client had
   dropped every NetworkPolicy's peers (fixed, see "Operators"). `oup link`,
   `oup service` and `oup secret` (#94), tested on the dev cluster
   (2026-11-01): a deploy created the Service and waited until it ran, a
   change of replicas was `deploying` until the operator had applied it,
   the same deploy again only resolved the tag, a piped Secret value lost
   its trailing line break and rolled both replicas; a private image on
   GHCR was refused without credentials and pulled by digest with
   `--registry-user` and the token on stdin (kubelet matched the
   repository key). Left: Docker Hub's credential key form is untested,
   for lack of a private Docker Hub image. The log stream (decision 103):
   the API, `oup service logs` and `oup job logs`. Tested against a local
   k3s 1.33 (2026-11-09): two replicas merged with their Site, a
   crash-looping one's last run from its previous log, its restarted
   container picked up while following, and a client that went away
   closing every Kubernetes read. The test found that aborting a read
   crashed the process (the Kubernetes client pipes the body without an
   error handler; fixed in `src/kube.ts`) and that the kubelet answers 200
   with a sentence of its own for a log it cannot read (dropped: it has no
   timestamp). Run on the dev cluster (k3s 1.36, gVisor, 2026-11-09)
   with the `worker` demo app, as the control plane's ServiceAccount:
   `oup service logs -f` on two replicas followed an `enqueue` run's tasks
   from both, and through a rollout picked up the two new pods as they
   started and the old ones' last lines on SIGTERM; the API gave each
   entry its pod's Site (one per compute Site). `oup job logs` showed the
   newest run whole, `-f` on a finished run ended at once (1.4 s), and
   `--tail 0` sent nothing. A worker without a Database showed its
   `DATABASE_URL is not set` from both crash-looping pods (k3s 1.36 keeps
   such a container `terminated` during the back-off, so it is the
   current log). No `Forbidden` or other error in the control plane's
   log; `kubectl auth can-i` confirmed it may list pods, read their logs
   and read a node, not list nodes. The disk and bandwidth limits
   (decisions 121 and 122), tested on the single-node dev cluster
   (2026-11-15, k3s 1.36) with gVisor pods made by hand with a Service's
   annotations and limits, and the bandwidth agent as its DaemonSet from
   the built image with `UPLINK_MBIT=100`: a pod that wrote 2.4 GB was
   evicted within seconds, and its QoS class stayed Guaranteed; a new
   pod's burst was 3.75 MB a moment after it started, and it then held
   296 Mbit/s each way from the first second (2.1 Gbit/s for two seconds
   with the CNI's burst); two pods downloading from the internet were cut
   to 39 Mbit/s each with the uplink at 79.8 Mbit/s, one alone to 79; the
   limits were back at 300 a second after the downloads ended, and at
   once when the DaemonSet was deleted during a cut. Left: the limits on
   a Service deployed through the API, the cut in the sending direction
   (the same code), and more than one node.
4. Containers, Cron job and One-off job modes. Done: Jobs API (#95,
   ADR-0003), the Jobs operator and runs, `oup job` (#96). Tested on the
   dev cluster (2026-11-01) with `oup job`: a Cron job every minute in
   `Europe/Berlin` became `ready` once the operator applied it and ran on
   schedule under `runsc` with a Secret in its environment; changing its
   schedule and switching it off were `deploying` until applied. A One-off
   job got its args and an added variable; a failing run made `oup job run`
   exit 1, and a run over its timeout failed with `DeadlineExceeded`.
   Stopping a run ended a waiting `oup job run` at once. A run reached the
   internet, not the cluster's Service network, the control plane or the
   metadata endpoint. Deleting a Job removed its CronJob and its runs, the
   last one also `job-egress`; neither the control plane nor the operator
   logged `Forbidden`. The test found that a run read as `pending` for a
   moment while its pod was stopped at the deadline (fixed: the outcome
   counts from `FailureTarget` and `SuccessCriteriaMet`).
5. Demo apps run end to end on the platform (#30), including `notes`
   staying writable while a whole Site is switched off. Code done: `notes`
   (decision 99) and `spa-api` (decision 100), the latter tested locally
   against Garage 2.4.1 behind a stand-in for its two Routes: files
   stored, listed, downloaded and deleted, a missing file a 404, and a 503
   at once with the process still healthy while Garage was stopped; and
   `worker` (decision 102), tested locally with its image against Postgres
   17: two replicas did 60 tasks of an `enqueue` run between them (28 and
   32), which then exited 0, `cleanup` deleted the done tasks, a worker
   kept retrying while the database was stopped, and SIGTERM let it finish
   its task and exit 0. Run on the dev cluster (2026-11-09), each app in a
   Project of its own, deployed with `oup` and served at its default
   hostname: `notes` with two replicas wrote and listed notes through the
   form and the API; `spa-api` served its site with SPA fallback and
   stored, listed, downloaded (`attachment`, CSP `sandbox`) and deleted
   files; `worker` did 100 tasks of an `enqueue` run with both replicas
   (70 and 30, the one in the Database primary's Site faster) and
   `cleanup -- 0` deleted the 200 done ones; Umami 3.4.1 unmodified from
   GHCR, with `APP_SECRET` as a Secret and 768 MB, applied its migrations
   through the Pooler, served its pages and stored an event sent to
   `/api/send`. Site failover: a note written every 0.5 s through the
   other Site's ingress while `hetzner-fsn1`, with the notes primary,
   was switched off: 401 notes acknowledged and all 401 stored, writes
   back after 87 s (41 s of timeouts until the node was NotReady, then
   44 s of 503 until the promotion), DNS left with the other Site; Umami,
   `spa-api`'s site and a worker run kept working, and the Site's
   Databases rejoined as standbys when it came back. The run found two
   bugs, both fixed: the Services operator refused the whole list of
   Services once a worker without a port existed, and customer pods
   could not reach their own node's ingress (decision 104). It also found
   Open question 20.

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
and collection through Mollie, in the billing service (#74, #77). Its
input, metering and the internal usage route, is in this repository
(decisions 114 and 115). Tested on the dev cluster (2026-11-15) with a
Database, a Service of two replicas, a Bucket site and a Cron job every
minute: one hour's events matched what ran (the Database's 256 MB and 1 GB
for the hour, the Service's two 256 MB replicas, the Bucket's 5 MB, 60 Job
runs of about 0.75 CPU seconds as 45.4 CPU seconds and 0.011 GB-hours), and
40 downloads of a 5 MB file as 0.19 GB of the Bucket's egress. Switching to
an IngressRoute per Resource dropped none of 468 requests. The run found
that Traefik names its metrics after the IngressRoute and a hash of the
rule, not the Kubernetes Service (fixed: decision 114's IngressRoute per
Resource), that cAdvisor never sees a short Job run's CPU (fixed: the CPU
agent, decision 115), and that the agent took a pod's new, still empty
cgroup for its end (fixed).

Until then sign-up on the hosted service is closed and `openupstream.com`
serves the waitlist (#86). Passing the gate means: `SIGNUP=open`, the
waitlist route and certificate removed, one e-mail to every confirmed address on the list,
then the list deleted, as its privacy notice promises.
