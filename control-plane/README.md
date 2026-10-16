# control-plane

The API behind the dashboard, the CLI and the SDK. Single Node.js process,
own Postgres for state, talks to the Kubernetes API to provision.

Responsibilities:

- accounts, API keys, sessions
- tenants and their resources: databases, buckets, sites, services, jobs
- the routing table (`domain → prefix → target`)
- secrets (envelope-encrypted, injected into containers as env)
- usage events → OpenMeter

Not here: anything that reconciles cluster state in a loop. That is `operators/`.
