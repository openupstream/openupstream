# Scope of version 1

Terms are defined in [GLOSSARY.md](../GLOSSARY.md). Customer data stays in
the EU; today everything runs in Germany, in three Sites at three providers
(Falkenstein, Frankfurt region, Nuremberg). Losing any one of them does not
stop your Databases or Buckets, nor Services with two or more replicas;
single-replica Services restart in the other Site.

## Offered

An Account holds Projects (for example, one for staging and one for
production). Everything below belongs to one Project; deleting the Project
deletes it all.

1. **Postgres**: one Postgres instance per Database via CloudNativePG, the
   primary in its Home site (Falkenstein by default) and a streaming standby
   in the Frankfurt region (async), automatic failover, PgBouncer, always on
   with a 256 MB floor, backups and point-in-time recovery, pgvector enabled.
2. **Object storage**: S3-compatible Buckets (Garage), every object stored in
   three Sites. Reads and writes keep working when one Site is down.
3. **Static sites**: a public Bucket served at a Domain through the routing
   table, SPA fallback, cache headers set by `oup site deploy`, compression.
   A feature of object storage, not a separate product.
4. **Containers**: the customer's image from any registry, in three modes:
   Service (HTTP), Cron job, One-off job. gVisor sandbox. Scales 1..N, no
   scale-to-zero.
5. **Routing**: `Domain → [(path prefix → Bucket | Service)]` per Project,
   automatic TLS. Every Project gets a default hostname; custom domains are
   added after a TXT-record ownership check.
6. **Secrets**: encrypted key-value store injected as environment variables.
7. **Log stream**: a live tail of a Service's or job's output.

Billed by memory GB-h (configured limit), CPU-seconds, storage GB-h and
egress GB (HTTP responses served to the internet). Copies in other Sites are
included in the unit price, not billed separately.

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
