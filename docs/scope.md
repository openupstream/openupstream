# Scope of version 1

Terms are defined in [GLOSSARY.md](../GLOSSARY.md). Customer data stays in
the EU; today everything runs in Germany, in three Sites at three providers
(Falkenstein, Frankfurt region, Nuremberg). Losing any one of them does not
stop your Databases or Buckets, nor Services with two or more replicas;
single-replica Services restart in the other Site. A self-hosted
installation runs in Sites of its own choosing, two compute Sites or more
(decision 150); `oup sites` and the dashboard list them, and the
dashboard's "Sites & nodes" page shows its admins every node and what is
wrong with their Site labels (decision 153).

## Offered

An Account holds Projects (for example, one for staging and one for
production). Everything below belongs to one Project; deleting the Project
deletes it all.

1. **Postgres**: one Postgres instance per Database via CloudNativePG, the
   primary in its Home site (Falkenstein by default) and a streaming standby
   in the Frankfurt region (async), automatic failover, PgBouncer
   (transaction pooling; session features such as `LISTEN` need a direct
   connection), always on with a 256 MB floor, memory and storage
   resizable, a guaranteed CPU share that follows the memory (a quarter
   core per GB, no CPU limit), storage growing by itself as it fills (unless the customer
   turns that off or sets a maximum), backups and point-in-time
   recovery into a new Database (also of a deleted one, within the backup
   retention window), pgvector enabled.
2. **Object storage**: S3-compatible Buckets (Garage), every object stored in
   three Sites. Reads and writes keep working when one Site is down. Each
   Bucket has an access key of its own and is reached at its own hostname,
   `<bucket>.s3.openupstream.app`. Deleting a Bucket deletes its objects;
   nothing is kept.
3. **Static sites**: a public Bucket served at a Domain through the routing
   table, below any path prefix, SPA fallback, cache headers set by
   `oup site deploy`, compression. A feature of object storage, not a
   separate product.
4. **Containers**: the customer's image from any registry, in three modes:
   Service (HTTP), Cron job, One-off job. gVisor sandbox. Scales 1..N, no
   scale-to-zero. Each pod has 2 GiB of scratch disk and 300 Mbit/s each
   way, less while its node's uplink is nearly full.
5. **Routing**: `Domain → [(path prefix → Bucket | Service)]` per Project,
   automatic TLS. Every Project gets a default hostname; custom domains are
   added after a TXT-record ownership check and CNAME to the platform's
   ingress hostname, which gets them a certificate of their own.
6. **Secrets**: encrypted key-value store injected as environment variables.
7. **Log stream**: a live tail of a Service's or job's output.

Billed by memory GB-h (configured limit), CPU-seconds, storage GB-h and
egress GB (HTTP responses served to the internet). Copies in other Sites are
included in the unit price, not billed separately.

Anyone can sign up; a payment method (card, PayPal or SEPA direct debit) is needed
before the first Database, Bucket or Service is created. Until the hosted
service can invoice, its sign-up is closed: `openupstream.com`, the product's welcome page
with a page per product and the documentation, says it is coming soon and
takes e-mail addresses for a waitlist at `/waitlist` (double opt-in), to
tell them when it opens. Whoever runs openupstream themselves has open
sign-up by default and can close it the same way. The hosted service
itself, with its dashboard, is at `console.openupstream.com`.

An Account's Members are owners or developers (every Project, but not
the Account itself), or have no role and only grants: access to single
Databases at a level, such as read-only for an analyst. Owners change
roles and grants and remove Members, and Postgres roles a Member may no
longer use are dropped within the next operator pass, as are those of a
deleted user and of a revoked API key. Account tokens give CI and tools
outside the platform the developer role or such access without belonging
to a person: owners create them with an expiry of at most a year, roll
their secret and revoke them.
Designed, not built yet:
owners invite people by e-mail with a role or with grants, and invited people may
sign up while sign-up is closed; Account tokens limited to source IP
ranges, and an e-mail to the owners before a token expires.

## Deliberately not offered

- **Queues.** Use `SELECT … FOR UPDATE SKIP LOCKED` on your Postgres; pg-boss
  and Graphile Worker package the pattern. You get transactional enqueue for
  free and one service less to depend on.
- **Transactional mail.** Deliverability is a reputation business. Use SES,
  Resend, Scaleway TEM or similar.
- **DNS, CDN.** Point your DNS at us; put Cloudflare in front if you want a
  global edge. Our ingress is in Germany and says so.
- **Logs and alerting as a product.** A live log stream only, nothing stored.
  We run Loki/Grafana for our own components, not for yours.
- **Building images.** Bring a built image from any registry; we do not build
  from source or host a registry.
- **Scale-to-zero databases.** A cold start of 5–15 s on the first query is a
  worse experience than paying a few cents a day for an idle instance.
- **Synchronous multi-site writes.** RPO is seconds, not zero.

## Acceptance

Small demo apps prove each build step (see `ARCHITECTURE.md`). The first real
customer, [ProjectMatch](https://projectmatch.io), migrates from AWS after
v1; its inventory and mapping are in `ARCHITECTURE.md`.
