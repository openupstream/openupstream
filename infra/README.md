# infra

The cluster itself. Changes here are deployed together with the control plane,
which is why it lives in the monorepo.

- `terraform/` — servers at Hetzner (Falkenstein), OVHcloud (Limburg) and
  netcup (Nuremberg; no official provider, so partly by hand), host
  firewalls, the Hetzner Object Storage bucket for backups, bunny.net DNS
  records and health checks.
- `helm/` — values files for the off-the-shelf components: Traefik,
  cert-manager, CloudNativePG, gVisor RuntimeClass, Prometheus/Loki/Grafana.
- `garage/` — Garage cluster layout and configuration: replication factor 3,
  one zone per site.
- `ingress/` — Traefik's values, cert-manager's DNS-01 webhook for bunny.net
  and its issuers, and the platform's public routes (ARCHITECTURE.md,
  "Ingress and failover"; decisions 69, 72, 73).
- `madauth/` — madAuth, sign-in and API keys, as its published image with the
  control plane's sidecar (ARCHITECTURE.md, decision 63).
- `dev-cluster/` — a throwaway three-Site k3s cluster on Hetzner Cloud for
  one working session (ARCHITECTURE.md, decisions 33 and 52).

Bootstrap order: Terraform → k3s install on the nodes → Helm releases → Garage
layout → control plane. A runbook lives in `docs/runbooks/bootstrap.md` once
the first cluster exists.

Nothing in this directory contains secrets. State is kept remotely; tfvars are
gitignored.
