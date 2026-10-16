# images

Dockerfiles for the images openupstream builds itself. Everything else
(Traefik, CloudNativePG, Garage, cert-manager) is used from upstream.

- `tenant-postgres/` — the Postgres image tenants run: upstream CloudNativePG
  image plus pgvector and the extensions we allow.
- `pgbouncer/` — connection pooler sidecar per tenant.

Images are published to `ghcr.io/openupstream/<name>`.
