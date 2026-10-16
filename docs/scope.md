# Scope of version 1

## Offered

1. **Postgres** — one instance per tenant via CloudNativePG, primary in FSN1
   with a streaming replica in NBG1 (async), automatic failover, PgBouncer,
   always on with a 256 MB floor, backups and PITR, pgvector enabled.
2. **Object storage** — S3-compatible (Garage), replicated FSN1 ↔ NBG1.
3. **Static sites** — a public bucket served at a hostname through the routing
   table, SPA fallback flag, sensible cache headers, compression at the edge.
   A feature of object storage, not a separate product.
4. **Containers** — customer image, three modes: HTTP service, cron job,
   one-off job. gVisor sandbox. Scales 1..N, no scale-to-zero.
5. **Routing** — one table per account: `domain → [(prefix → bucket | service)]`,
   automatic TLS.
6. **Secrets** — encrypted key-value store injected as environment variables.

## Deliberately not offered

- **Queues.** Use `SELECT … FOR UPDATE SKIP LOCKED` on your Postgres; pg-boss
  and Graphile Worker package the pattern. You get transactional enqueue for
  free and one service less to depend on.
- **Transactional mail.** Deliverability is a reputation business. Use SES,
  Resend, Scaleway TEM or similar.
- **DNS, CDN.** Point your DNS at us; put Cloudflare in front if you want a
  global edge. Our ingress is in Germany and says so.
- **Logs and alerting as a product.** A log stream endpoint only. We run
  Loki/Grafana for ourselves.
- **Scale-to-zero databases.** A cold start of 5–15 s on the first query is a
  worse experience than paying a few cents a day for an idle instance.
- **Synchronous multi-site writes.** RPO is seconds, not zero.

## First customer

[ProjectMatch](https://projectmatch.io) is being migrated from AWS (19 Lambdas,
10 DynamoDB tables, S3, SQS, SES, CloudFront) onto this platform. Its needs
define the order in which things get built. See `ARCHITECTURE.md`.
