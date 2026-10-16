# openupstream

Open source cloud infrastructure, hosted in Germany.

openupstream is a small cloud provider for developers who want their data and
compute in the EU, run on open source, and billed by what they use. The whole
platform lives in this repository; the hosted service at
[openupstream.com](https://openupstream.com) runs exactly this code.

> Status: pre-alpha. Nothing here is usable yet. The first customer will be
> [ProjectMatch](https://projectmatch.io), which is being migrated off AWS to
> drive the roadmap.

## What it offers (v1 scope)

| Product | What you get | Billed by |
| --- | --- | --- |
| **Postgres** | One Postgres instance per tenant, primary in Falkenstein and a streaming replica in Nuremberg, automatic failover, PITR, pgvector | memory GB-h, CPU-seconds, storage GB-h |
| **Object storage** | S3-compatible buckets, replicated across both sites | storage GB-h, egress GB |
| **Static sites** | A public bucket served at your domain, SPA fallback, TLS | through object storage |
| **Containers** | Your image as an HTTP service, cron job or one-off job, sandboxed with gVisor | CPU-seconds, memory GB-h, egress GB |

Everything behind one routing table: `domain → (path prefix → bucket | service)`.

Not offered, on purpose: queues (use `SELECT … FOR UPDATE SKIP LOCKED` on your
Postgres), transactional mail, DNS, CDN. See [docs/scope.md](docs/scope.md).

## Repository layout

```
control-plane/   API: tenants, routing table, secrets, metering, provisioning
dashboard/       Next.js web UI
cli/             `oup` command line tool
sdk/             @openupstream/sdk, TypeScript client used by cli and dashboard
operators/       Kubernetes reconcilers (routing table → IngressRoutes, tenant → CloudNativePG)
images/          Dockerfiles for our own images (tenant Postgres, PgBouncer)
infra/           The cluster itself: Terraform for Hetzner, Helm values, Garage config
docs/            Architecture, decision records (adr/), runbooks
```

## Stack

- Hetzner dedicated servers, FSN1 + NBG1
- k3s, gVisor (`runsc`) as RuntimeClass for customer workloads
- Traefik + cert-manager for ingress and TLS
- CloudNativePG for tenant databases, backups to Hetzner Object Storage
- Garage for object storage
- OpenMeter for usage metering, Stripe for invoicing
- Node.js 22 / TypeScript throughout the control plane

Details and the reasoning behind each choice: [ARCHITECTURE.md](ARCHITECTURE.md).

## Development

```sh
npm install
npm run build
npm test
```

Each workspace has its own README with the parts that are specific to it.

## License

[AGPL-3.0-only](LICENSE). You can run openupstream yourself, modify it and
offer it as a service; if you do, your modifications must be published under
the same license.
