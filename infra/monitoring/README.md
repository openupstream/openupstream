# monitoring

The platform's own monitoring, in the namespace `monitoring`
(ARCHITECTURE.md, "Observability and customer logs"; decisions 106 and
107). `infra/dev-cluster/monitoring.sh` installs it; docs/self-hosting.md,
section 10, has what it needs outside the cluster.

| File | |
| --- | --- |
| `kube-prometheus-stack-values.yaml` | Prometheus and Alertmanager twice, in two different compute Sites, each with a PodDisruptionBudget (decision 157), Grafana, node-exporter on every node, kube-state-metrics; Alertmanager's routes: e-mail through SES, the `Watchdog` to healthchecks.io |
| `scrape.yaml` | PodMonitors for every Database's instances and Poolers, Garage, Traefik, cert-manager and the control plane's Site checks (port `metrics`) |
| `scrape.yaml` (`cpu-agent`) | the CPU agent's per-pod CPU totals, which metering reads (decision 115) |
| `rules.yaml` | the platform's alerts beyond the stack's defaults: Databases (and their volumes filling or failing to grow), Garage, certificates, Traefik, and the nodes' Site labels (one alert per rule, from the control plane's Site checks, ADR-0008); `monitoring.sh` fills in `DATABASE_INSTANCES` (2, or 1 on a single-node dev cluster) |
| `loki-values.yaml` | Loki single-binary three times in three different Sites, a non-compute Site included (replication factor 3; once with factor 1 on a single-node dev cluster), its data in the Garage bucket `openupstream.platform-logs`, kept 14 days, and a PodDisruptionBudget, so a drain stops one at a time (decision 157) |
| `alloy-values.yaml` | Alloy on every node, shipping the logs of the platform's namespaces only |
| `ses-smtp-password.mjs` | derives the SES SMTP password from the send-only key, for Alertmanager |

Customer workloads are not monitored as such: their logs are never
collected (decision 21), and the workload alerts cover the platform's
namespaces only. Their Databases are, through the NetworkPolicy
`database-metrics` the Databases operator applies in each Project: it lets
Prometheus's pods reach CloudNativePG's metrics ports, nothing else.

To add a component's metrics, add a PodMonitor or ServiceMonitor in any
namespace: Prometheus picks up all of them, not only this release's. A
new platform namespace goes into three lists that must stay equal: the
workload alerts' (`defaultRules.appNamespacesTarget`), the certificate
alerts' (`rules.yaml`) and Alloy's (`alloy-values.yaml`).
