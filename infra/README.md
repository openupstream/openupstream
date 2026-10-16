# infra

The cluster itself. Changes here are deployed together with the control plane,
which is why it lives in the monorepo.

- `terraform/` — Hetzner dedicated servers (via Robot) and cloud resources
  (vSwitch, firewall, Object Storage bucket for backups), DNS records.
- `helm/` — values files for the off-the-shelf components: Traefik,
  cert-manager, CloudNativePG, gVisor RuntimeClass, Prometheus/Loki/Grafana.
- `garage/` — Garage cluster layout and configuration for FSN1 ↔ NBG1.

Bootstrap order: Terraform → k3s install on the nodes → Helm releases → Garage
layout → control plane. A runbook lives in `docs/runbooks/bootstrap.md` once
the first cluster exists.

Nothing in this directory contains secrets. State is kept remotely; tfvars are
gitignored.
