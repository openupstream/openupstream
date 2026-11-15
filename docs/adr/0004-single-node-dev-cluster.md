# ADR-0004: A single-node dev cluster

Date: 2026-11-15
Status: accepted

## Context

The only way to run the platform so far was the Hetzner dev cluster
(decision 52): three VMs per working session, one per Site, created with
`hcloud`. Running it on one machine, such as a mini PC at home, did not
work, and the reason was the copies, not k3s. k3s runs on one node, but
the platform's manifests ask for copies on different nodes:

- Garage keeps three copies, one pod per Site (required anti-affinity);
- Loki keeps three copies, one per Site;
- every Database runs a primary and a standby, which must sit in
  different compute Sites, and two PgBouncers likewise.

On one node the second and third copies stay `Pending`, and what depends
on them does not work.

Three VMs on one machine would satisfy those rules unchanged, but the
redundancy would be fake (one machine, one failure) and would cost about
24 GB of RAM and two or three times the disk for copies that protect
nothing. A single node with one copy of everything needs about a third
of that.

## Decision

1. **Two layouts, recorded in the cluster.** `multi-node` is one node
   per Site, as in production; `single-node` is one node standing in for
   every Site, for development only. The entry script records the
   layout once in the ConfigMap `openupstream-system/cluster-layout` and
   refuses to change it later. Every install step (`operators.sh`,
   `ingress.sh`, `garage.sh`, `platform.sh`, `monitoring.sh`) reads it
   from there, so a step run again on its own installs the same way.
2. **Two entry scripts.** `infra/dev-cluster/install-multi-node.sh`
   refuses a cluster without a node in each of the three Sites, since
   two nodes would break as well (Garage's three copies, etcd's quorum).
   `install-single-node.sh` refuses any number of nodes but one.
3. **One copy in single-node.** Garage and Loki run one node with
   replication factor 1. Each Database gets one instance and one
   PgBouncer (`layout` in the DatabaseConfig), stored with k3s's
   local-path provisioner instead of TopoLVM (decision 109): no disk to
   prepare, but sizes are neither reserved nor checked (the API's room
   check finds no TopoLVM capacity and accepts any size), and growing
   storage never completes. madAuth, the control
   plane, CoreDNS, the CloudNativePG operator, Prometheus and
   Alertmanager run once instead of once per compute Site. The alert
   for a Database without a standby cannot fire.
4. **The node stands in for every Site.** It carries the label of the
   compute Site `hetzner-fsn1`. The API, the CLI and the operators'
   placement are unchanged: a Database or Service with the Home site
   `ovh-lim` runs on that node too, because Home site placement is a
   preference, not a requirement.
5. **The infrastructure scripts are split.** `infra/dev-cluster` holds
   what installs onto any k3s cluster, plus `k3s-single-node.sh`, which
   sets up one Linux machine over SSH (gVisor, then k3s, as `up.sh`
   does). The Hetzner VM scripts (`up.sh`, `down.sh`) move to
   `infra/dev-cluster-hetzner`. Nothing in the repository names a
   particular machine.
6. **Hostnames are public DNS pointing at the node's own address.**
   `dns.sh` reads the compute nodes' addresses from Kubernetes
   (ExternalIP, else InternalIP; IPv4) instead of from `hcloud`. In a
   home network that is a private address: the names resolve everywhere
   but lead somewhere only inside that network. `k3s-single-node.sh`
   takes `NODE_ADDRESS` as the node's ExternalIP, e.g. its Tailscale
   address, so the cluster is reached from the tailnet only. `PLATFORM_DOMAIN` and
   `CUSTOMER_DOMAIN` are required in single-node (no default, so it never
   takes over the shared dev zones) and may be names inside a bunny.net
   zone, e.g. `home.dev.example.com` in `dev.example.com`. Certificates
   come from Let's Encrypt through the bunny.net DNS-01 challenge, which
   needs no inbound connection. A single-node cluster uses the production
   issuer by default, since it lives longer than one session.
   Single-node records get no health check: there is no other record to
   fall back to, and a private address cannot be checked from outside.

## Consequences

- One machine (x86_64, about 8 to 12 GB of RAM) runs the whole platform,
  with no router port forwarding and no inbound access from the
  internet.
- Losing the node loses every Database, Bucket and Service on it; only
  the Databases' backups in Hetzner Object Storage survive. Failover,
  placement across Sites and the third Site cannot be tested on it. That
  stays the job of the Hetzner dev cluster.
- A CloudNativePG or k3s upgrade restarts the only Database instance, so
  a single-node cluster has downtime during upgrades.
- Custom domains cannot get certificates: their HTTP-01 challenge needs
  Let's Encrypt to reach the node on port 80.
- Routers with DNS rebinding protection (a Fritz!Box, for example) drop
  public answers that contain private addresses; the domain needs an
  exception there. The node's address must stay fixed (a DHCP
  reservation), and it is visible in public DNS.
- The cluster still uses the same outside services as the Hetzner dev
  cluster: bunny.net (DNS and DNS-01), Hetzner Object Storage (backups),
  SES (e-mail, or `MAIL=log`), GHCR (images).
- Production is a multi-node cluster; nothing in the operators' code
  chooses single-node unless the DatabaseConfig says so.
