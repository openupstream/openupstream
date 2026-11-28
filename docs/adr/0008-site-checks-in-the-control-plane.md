# ADR-0008: Site checks in the control plane, a nodes page for admins

Date: 2026-11-28
Status: accepted

## Context

ADR-0007 made the nodes' labels the only source of the Sites, with the
node setup as their only writer. The install's `check_sites` refuses a
layout that breaks the rules, but it runs once. While the cluster runs,
two alerts from kube-state-metrics' `kube_node_labels` were meant to catch
drift:

- `SiteNodeWithoutRole`: a node in a Site with neither the compute label
  nor the taint.
- `DefaultSiteNotOne`: zero or several default Sites.

Looked at again, they fell short:

- **Gaps.** A node joined with no labels at all has no zone label, so
  `SiteNodeWithoutRole` never looked at it: it sat unused and nothing said
  so. Half of the install's rules had no runtime check: a node labelled
  compute and tainted, a Site whose nodes disagree, a default Site that is
  no compute Site, too few compute Sites or Sites.
- **Names.** "Role" already means something else for nodes (`kubectl get
  nodes` shows `ROLES control-plane,etcd`), and "NotOne" does not say
  whether the default is missing or ambiguous.
- **Visibility.** An alert reaches only whoever reads Alertmanager's
  receiver. A self-hoster who adds a node by hand looks at the dashboard,
  which knew nothing about nodes.
- **Three copies of the rules.** The install's bash, the PromQL, and
  whatever the dashboard would show would each spell the rules out.

The taint `openupstream.io/third-site` was also named after ADR-0002's
layout of two compute Sites and one more. With any number of non-compute
Sites, or none, the name says nothing; what those nodes are for is
quorum (etcd, and Garage's and Loki's third copy).

## Decision

1. **The control plane checks the Site labels.** `siteProblems` in
   `control-plane/src/sites.ts` applies the install's rules to the node
   list the control plane already reads every 30 s (`get` and `list` on
   nodes, nothing more). Every node has a Site; a node is labelled
   compute or tainted quorum-only, never both; the nodes of a Site agree
   on the compute and the default label; exactly one Site is the
   default, a compute one. With more than one node: at least two compute
   Sites and three Sites. A single-node install has exactly one node, so
   the count of nodes tells the layouts apart. Each problem has a kind, the
   node or Site it is about, a sentence and the `kubectl` command that
   fixes it.
2. **One alert per rule, from a metric of the control plane.** It serves
   `openupstream_site_problem{problem, node, site} 1` per problem and
   `openupstream_site_nodes` on a port of its own (`METRICS_PORT`, 8083),
   which only Prometheus may reach (NetworkPolicy
   `metrics-from-prometheus`, PodMonitor `control-plane`). The group
   `sites` of `infra/monitoring/rules.yaml` has one alert per kind, named
   for its cause:
   - `NodeWithoutSite`, `NodeNeitherComputeNorQuorum`, `NodeComputeAndQuorum`
   - `SiteMixedCompute`, `SiteMixedDefault`
   - `DefaultSiteMissing`, `DefaultSiteNotUnique`, `DefaultSiteNotCompute`
   - `ComputeSitesBelowTwo`, `SitesBelowThree`

   `SiteChecksAbsent` fires when no replica reports the checks. Both
   replicas report the same; each alert takes the max. kube-state-metrics
   no longer exports node labels.
3. **A "Sites & nodes" page for the installation's admins.**
   `GET /v1/admin/nodes` returns every node (Site, compute, default,
   quorum-only, description, Ready) and the problems, for a caller with
   madAuth's role `admin` signed in (a session or `oup`'s access token,
   whose madAuth claims carry the roles); API keys and Account tokens are
   refused. The dashboard links `/nodes` for such users and marks each node
   that needs attention with the fix. madAuth's `admin` is the
   installation's admin: whoever installs gets it through
   `INITIAL_ADMIN_EMAIL`, and a madAuth admin could grant themselves any
   other role, so a role of its own would protect nothing.
4. **The taint is `openupstream.io/quorum-only=true:NoSchedule`.**

## Consequences

- The rules exist twice, in the install's bash (it runs before the control
  plane) and in TypeScript; the alerts and the page read the TypeScript.
  The PromQL is one line per kind.
- A node that joins without its labels shows on the page at the next
  refresh (within 30 s), marked with the command that fixes it, and the
  alert fires after 10 minutes.
- The checks run only while the control plane runs, which needs a compute
  node. A cluster with no compute node at all has no control plane, no
  Prometheus and no page; the install's check is what prevents that.
  `SiteChecksAbsent` covers a control plane that is down or cannot list
  the nodes.
- The control plane gains a third port and a NetworkPolicy, and the API
  its first route for the installation's admins rather than an Account's
  Members. A role taken away in madAuth counts once the session token is
  renewed.
- Renaming the taint needs every node tainted anew; the only installation,
  the Incus dev cluster, is reinstalled from scratch.
- Considered and turned down: alerts on `kube_node_labels` alone (no
  page, a third copy of the rules for the page); the dashboard showing
  Alertmanager's firing alerts (no node list, ten minutes late, and the
  control plane would need to reach Alertmanager); a role `operator` of
  its own (a manual step per installation, no protection against madAuth's
  admins); the names `no-compute` and keeping `third-site` for the taint.
- Amends ADR-0007: its point 2's alerts and its taint name.
