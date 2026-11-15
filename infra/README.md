# infra

The cluster itself. Changes here are deployed together with the control plane,
which is why it lives in the monorepo.

- `helm/` — values files for the off-the-shelf components: Traefik,
  cert-manager, CloudNativePG.
- `monitoring/` — the platform's own monitoring: kube-prometheus-stack,
  Loki and Alloy values, scrape targets and alert rules (ARCHITECTURE.md,
  decisions 106 and 107).
- `gvisor/` — gVisor for customer containers: `install.sh` puts a pinned
  `runsc` on a compute node and into k3s's containerd template, before k3s
  starts; `runtimeclass.yaml` is the RuntimeClass `gvisor`, scheduled only
  on nodes labelled `openupstream.io/gvisor=true` (ARCHITECTURE.md,
  decision 90).
- `topolvm/` — TopoLVM, the Databases' local volumes: thick logical
  volumes in the volume group `openupstream` on the compute Sites
  (`values.yaml`), made by `vgcreate.sh` from a block device
  (ARCHITECTURE.md, decision 109).
- `garage/` — Garage cluster layout and configuration: replication factor 3,
  one zone per site (1 on a single-node dev cluster).
- `apparmor/` — our copy of containerd's AppArmor profile for containers,
  with the rules Ubuntu 26.04's stacked labels need, so a container's
  processes can signal each other (ARCHITECTURE.md, decision 113).
- `ingress/` — Traefik's values, cert-manager's DNS-01 webhook for bunny.net
  and its issuers, and the platform's public routes (ARCHITECTURE.md,
  "Ingress and failover"; decisions 69, 72, 73).
- `madauth/` — madAuth, sign-in and API keys, as its published image with the
  control plane's sidecar (ARCHITECTURE.md, decision 63).
- `dev-cluster/` — installs the platform onto a k3s cluster for
  development, with one node per Site or on a single node, and sets up one
  Linux machine as such a node (ARCHITECTURE.md, decision 112).
- `dev-cluster-hetzner/` — a throwaway three-Site k3s cluster on Hetzner
  Cloud for one working session (ARCHITECTURE.md, decisions 33 and 52).

Bootstrap order: servers ordered by hand (ARCHITECTURE.md, decision 116) →
node setup over SSH (host firewall, AppArmor profile, gVisor, volume group,
k3s; the production script is not written yet, `dev-cluster-hetzner/up.sh`
does it for the dev cluster) → `dev-cluster/install-multi-node.sh` (Helm
releases, Garage layout, control plane, DNS records and health checks). The
backup bucket is made by hand (`docs/self-hosting.md`, section 4). A runbook lives in `docs/runbooks/bootstrap.md` once
the first cluster exists.

Nothing in this directory contains secrets.
