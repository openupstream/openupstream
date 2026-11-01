# openupstream

Open source cloud infrastructure, hosted in the EU.

OpenUpstream is a cloud provider based in Germany with EU-only hosting.
Keep your code highly available by using the default multi-region hosting. Save money by paying a fraction compared to AWS, Azure and GCP. You can also host the plattform yourself and pay only for the infrastructure.


The whole platform lives in this repository; the hosted service at
[openupstream.com](https://openupstream.com) runs exactly this code.

> Status: pre-alpha. See the plan for verstion 1 below.

## What it offers (v1 scope)

| Product | What you get | Billed by |
| --- | --- | --- |
| **Postgres** | One Postgres instance per database, primary in Falkenstein and a streaming standby in the Frankfurt region, automatic failover, PITR, pgvector | memory GB-h, CPU-seconds, storage GB-h |
| **Object storage** | S3-compatible buckets, every object stored in three sites | storage GB-h, egress GB |
| **Static sites** | A public bucket served at your domain, SPA fallback, TLS | through object storage |
| **Containers** | Your image from any registry as an HTTP service, cron job or one-off job, sandboxed with gVisor | CPU-seconds, memory GB-h, egress GB |

Resources live in projects (e.g. staging and production) under one account.
Everything behind one routing table: `domain → (path prefix → bucket | service)`.

Not offered, on purpose: queues (use `SELECT … FOR UPDATE SKIP LOCKED` on your
Postgres), transactional mail, DNS, CDN. See [docs/scope.md](docs/scope.md).

## Repository layout

```
control-plane/   API: accounts, projects, routing table, secrets, metering, provisioning
dashboard/       Next.js web UI
cli/             `oup` command line tool
sdk/             @openupstream/sdk, TypeScript client used by cli and dashboard
operators/       Kubernetes reconcilers (routing table → IngressRoutes, database → CloudNativePG)
images/          Dockerfiles for our own images (Postgres, PgBouncer)
examples/        Demo apps that prove each build step (notes, spa-api, worker)
infra/           The cluster itself: Terraform for Hetzner, Helm values, Garage config
docs/            Architecture, decision records (adr/), runbooks
```

## Stack

- Three sites at three providers, all in Germany: Hetzner Falkenstein and
  OVHcloud Limburg (compute), netcup Nuremberg (quorum and third storage copy)
- bunny.net DNS with health checks for active-active ingress
- k3s across the three sites, gVisor (`runsc`) as RuntimeClass for customer workloads
- Traefik + cert-manager for ingress and TLS
- CloudNativePG for customer databases, backups to Hetzner Object Storage
- Garage for object storage
- Usage events in Postgres, rated monthly by the control plane; invoices
  through lexoffice, payments through Mollie (card, PayPal or SEPA Direct Debit)
- madAuth for sign-in and API keys
- Node.js 22 / TypeScript throughout the control plane

Details and the reasoning behind each choice: [ARCHITECTURE.md](ARCHITECTURE.md).

## Development

```sh
npm install
npm run build
npm test
```

The control plane's tests need Docker, or a Postgres server in
`TEST_DATABASE_URL`; see [control-plane/README.md](control-plane/README.md).

Each workspace has its own README with the parts that are specific to it.

## Running it yourself

[docs/self-hosting.md](docs/self-hosting.md) lists the tools, accounts,
credentials and domains the platform needs, and how we set them up for the
hosted service; [infra/dev-cluster](infra/dev-cluster/README.md) brings up a
development cluster with them.

---

Created by David Neuy and
[contributors](https://github.com/openupstream/openupstream/graphs/contributors).

## License

[AGPL-3.0-only](LICENSE). You can run openupstream yourself, modify it and
offer it as a service; if you do, your modifications must be published under
the same license.
