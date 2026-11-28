# ADR-0007: Sites read from the nodes' labels

Date: 2026-11-27
Status: accepted; amended by ADR-0008 (the taint is now
`openupstream.io/quorum-only`, the alerts come from the control plane's
Site checks) and ADR-0009 (Site descriptions are the control plane's)

## Context

ADR-0002 put the platform in three Sites at three providers, and the code
fixed them by name: `COMPUTE_SITES = ['hetzner-fsn1', 'ovh-lim']` in the
SDK, the API's validation, check constraints on `home_site` in three
tables, `hetzner-fsn1` as the default Home site in SQL, and
`topology.kubernetes.io/zone In [hetzner-fsn1, ovh-lim]` in about a dozen
manifests. A self-hosted installation had to name its nodes after our
providers: on the Incus dev cluster (decision 137), three VMs on one
machine at home are called `hetzner-fsn1`, `ovh-lim` and `netcup-nbg`, and
the dashboard's "Primary in" list offers exactly those two names, which
say nothing about where a Database would run.

The layout was fixed too: exactly two compute Sites and one third Site, or
a single node.

## Decision

The Sites are what the nodes say. Nothing in the code names a Site.

1. **Node labels are the source of truth.** Every node carries its Site's
   id as `topology.kubernetes.io/zone` (as before). A Site id is a
   Kubernetes label value: at most 63 letters, digits, `-`, `_` and `.`,
   starting and ending with a letter or digit.
   - The nodes of a **compute Site** also carry
     `openupstream.io/compute-site=true`. Databases, Services, Jobs,
     Traefik, TopoLVM and the platform's own pods select on this label,
     never on a list of zones.
   - The nodes of every other Site keep the taint
     `openupstream.io/third-site=true:NoSchedule` (name kept from
     ADR-0002), so only etcd, Garage, Loki and the node agents run there.
   - The nodes of exactly one compute Site carry
     `openupstream.io/default-site=true`: the default Home site of a
     Database, Service or Job created without one.
   - A node may carry the annotation `openupstream.io/site-description`, a
     free text such as `Falkenstein (Hetzner)` or `Home VM A`, shown next
     to the id. When a Site's nodes disagree, the oldest node's wins;
     without one the id is shown alone.
2. **One writer: the node setup.** A node gets its labels when it joins
   (k3s `--node-label`) and its description right after (`kubectl
   annotate`), from the script that sets the machine up
   (`infra/dev-cluster-hetzner/up.sh`, `infra/dev-cluster-incus/up.sh`,
   `infra/dev-cluster/k3s-single-node.sh`, and the production node setup
   of decision 117). A node's role is a property of the machine, set where
   the machine is made, as Kubernetes' own well-known labels are. Moving
   the default Site, or a node's role, is a `kubectl label`. Everything
   else only reads: the scheduler, the control plane (`get` and `list` on
   nodes, never `patch`) and the bootstrap.
   - `install-multi-node.sh` and `install-single-node.sh` check the labels
     and change nothing: they refuse a layout that breaks the rules below
     and name the `kubectl` command that fixes it.
   - Two alerts check them while the cluster runs, so a node added,
     removed or relabelled later is caught: `SiteNodeWithoutRole` (a node
     in a Site with neither the compute label nor the taint) and
     `DefaultSiteNotOne` (zero or several default Sites), from
     kube-state-metrics' `kube_node_labels` with the three labels
     allowed.
3. **Any number of Sites.** `multi-node` needs at least two compute Sites
   (a Database's standby must go to another one) and at least three Sites
   in all (etcd's and Garage's quorum); any number of Sites beyond that,
   compute or not. With three compute Sites no non-compute Site is needed.
4. **What scales with the Sites and what does not.**
   - A Database keeps one primary and one standby: two instances in two
     different compute Sites, the primary preferring its Home site. A new
     Database needs room in its Home site and in one other compute Site.
     More instances per Database is a separate decision (Open questions).
   - What ran "once per compute Site" (madAuth, Prometheus and
     Alertmanager, CoreDNS, the CloudNativePG operator, the control plane,
     the dashboard) runs `min(2, compute Sites)` replicas spread over
     different compute Sites: enough to survive one Site failure. Traefik
     stays a DaemonSet on every compute node.
   - Garage and Loki keep one copy per Site up to three (`min(3, Sites)`),
     quorum two.
5. **The control plane reads the Sites from the nodes.** It lists the
   nodes (cached for 30 s) and serves the compute Sites at `GET /v1/sites`
   as `{ id, description, default }`. It validates a `homeSite` against
   that list and fills in the default Site where none is given. The
   `home_site` columns keep only a format check. The SDK's `Site` is a
   string and `COMPUTE_SITES` is gone (SDK 0.6.0); the dashboard and the
   CLI ask the API.

## Consequences

- Production and the existing dev clusters keep their Site ids, so no row
  changes. An existing cluster needs the labels once: `kubectl label nodes
  -l 'topology.kubernetes.io/zone in (hetzner-fsn1,ovh-lim)'
  openupstream.io/compute-site=true` and `kubectl label nodes -l
  topology.kubernetes.io/zone=hetzner-fsn1 openupstream.io/default-site=true`.
- No install configuration holds the Sites: no variables, no ConfigMap.
  A node that joins without its labels gets no customer pods until it is
  labelled, and the alert says so.
- A self-hoster names the Sites after their own places, and the dashboard
  shows "Home VM A · home-a" instead of a provider they do not use.
- The list is runtime state. A Site whose nodes are all deleted (not just
  NotReady) leaves the list: its Databases, Services and Jobs keep running
  where they can, but a create or a PATCH naming it is refused until a node
  of it joins again. A dark Site's NotReady nodes still count.
- A request that validates a Site reads the node list, from a 30 s cache;
  the control plane needs `list` on nodes. When the API server cannot be
  asked and nothing is cached, the request fails with 503 instead of
  accepting a Site nobody checked. The control plane starts without a
  compute Site unless a platform Database row is still to be seeded,
  which needs the default Site; so does the bootstrap
  (`reconcile-databases.ts --platform`). Until the nodes are labelled, its
  requests that need a Site answer 503.
- Breaking for SDK users who imported `COMPUTE_SITES` or relied on `Site`
  being a union of two names.
- Considered and turned down: the install writing the labels from
  variables (a second writer, and adding a node meant running the whole
  install again); the Sites in the control plane's Postgres (the scheduler
  can only place pods by node labels, so it would be a second copy; the
  bootstrap runs before that Postgres exists); an admin API that writes
  the labels (the control plane would need `patch` on nodes, so a bug or a
  leaked token could move every workload).
- Amends ADR-0002, which still describes production; its "two compute
  Sites and one third Site" is now one layout among several.
