# monitoring

The platform's own monitoring, in the namespace `monitoring`
(ARCHITECTURE.md, "Observability and customer logs"; decisions 106 and
107). `infra/dev-cluster/monitoring.sh` installs it; docs/self-hosting.md,
section 10, has what it needs outside the cluster.

| File | |
| --- | --- |
| `kube-prometheus-stack-values.yaml` | Prometheus and Alertmanager once per compute Site, Grafana, node-exporter on all three Sites, kube-state-metrics; Alertmanager's routes: e-mail through SES, the `Watchdog` to healthchecks.io |
| `scrape.yaml` | PodMonitors for every Database's instances and Poolers, Garage, Traefik and cert-manager |
| `rules.yaml` | the platform's alerts beyond the stack's defaults: Databases, Garage, certificates, Traefik |
| `loki-values.yaml` | Loki single-binary, its data in the Garage bucket `openupstream.platform-logs`, kept 14 days |
| `alloy-values.yaml` | Alloy on every node, shipping the logs of the platform's namespaces only |
| `ses-smtp-password.mjs` | derives the SES SMTP password from the send-only key, for Alertmanager |

Customer workloads are not monitored as such: their logs are never
collected (decision 21), and the workload alerts cover the platform's
namespaces only. Their Databases are, through the metrics ports each
Project's NetworkPolicy opens to this namespace.

To add a component's metrics, add a PodMonitor or ServiceMonitor in any
namespace: Prometheus picks up all of them, not only this release's. A
new platform namespace goes into three lists that must stay equal: the
workload alerts' (`defaultRules.appNamespacesTarget`), Alloy's
(`alloy-values.yaml`), and, if Prometheus must reach into Project
namespaces for it, `operators/src/kubernetes.ts`.
