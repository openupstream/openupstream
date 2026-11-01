# operators

Kubernetes reconcilers written in TypeScript. They watch the control plane's
desired state and the cluster's actual state and close the gap.

Kept deliberately thin: every behaviour that CloudNativePG, cert-manager or
Traefik already implements is configured, not reimplemented.

## Layout

- `src/databases/manifests.ts`: a Database → its CloudNativePG `Cluster`,
  PgBouncer `Pooler`, Barman Cloud `ObjectStore` and `ScheduledBackup`, and a
  restored Database → the same with a Cluster that bootstraps from another
  Database's backups. Pure functions; invalid input comes back as a list of
  errors.
- `src/databases/reconcile.ts`: one reconcile pass. `planDatabases` (pure)
  turns rows into the objects to apply: per Project its namespace, its
  NetworkPolicy and a copy of the backup credentials Secret, then each Database's objects.
  `reconcileDatabases` applies them with server-side apply. It never deletes
  (ARCHITECTURE.md, decision 48).
- `src/routes/`: the Routes operator (ARCHITECTURE.md, decisions 84 and
  85). `planRoutes` (pure) turns the routing table into, per Project, its
  namespace and NetworkPolicy, an ExternalName Service to Garage's website endpoint and the
  shared Middlewares (compression, HSTS), and with a Route to a Service the
  ServersTransport `fail-fast` and the Middleware `retry-other-pod`; per
  Route to a Bucket, a Middleware that sets the Host header to the Bucket's
  name and one that strips the prefix; per
  Domain, an IngressRoute, on the default certificate for a default Domain,
  on a Certificate of its own from `CLUSTER_ISSUER` (HTTP-01) for a custom
  domain. `reconcileRoutes`
  applies them and deletes the objects labelled
  `openupstream.io/component=routes` that are no longer wanted. A pass
  without the routing table applies and deletes nothing.
- `src/services/`: the Services operator (ARCHITECTURE.md, decision 93).
  `planServices` (pure) turns the Services into, per Project, its namespace,
  its NetworkPolicy and `service-egress` (DNS, the own namespace and the
  internet only); per Service, a Deployment `svc-<id>` with the image
  pinned by digest under the `gvisor` RuntimeClass and, unless it is a
  worker without a port, a readiness probe and a Kubernetes Service.
  `reconcileServices` applies them and deletes the objects labelled
  `openupstream.io/component=services` that are no longer wanted.
- `databaseEnv` (`src/kubernetes.ts`, decision 97): the environment both
  operators give a container for the Project's Databases,
  `DATABASE_URL_<NAME>` per Database and `DATABASE_URL` for the oldest,
  with the password from CloudNativePG's `db-<id>-app` Secret through a
  `secretKeyRef`; no operator reads that Secret.
- `src/jobs/`: the Jobs operator (ARCHITECTURE.md, decision 95,
  ADR-0003). `planJobs` (pure) turns the Jobs into, per Project, its
  namespace, its NetworkPolicy and `job-egress` (the egress of a Service's
  pods); per Job, a CronJob `job-<id>`, suspended when the Job has no
  schedule, whose jobTemplate runs the image pinned by digest under gVisor
  once (`backoffLimit: 0`), stops it at the Job's timeout and keeps the
  finished run a day. It carries the Job's spec version, which the control
  plane checks before it copies the template into a One-off job.
  `reconcileJobs` applies them and deletes the CronJobs and NetworkPolicies
  labelled `openupstream.io/component=jobs` that are no longer wanted; their
  runs go with them, by Kubernetes' garbage collection.
- `src/owned.ts`: the apply-then-prune pass the Routes, Services and Jobs
  operators share.
- `src/main.ts`: the image's entry point; `OPERATOR` (`databases`, the
  default, `routes`, `services` or `jobs`) picks which operator the process runs,
  each in its own Deployment with its own ServiceAccount.
- `src/databases/loop.ts`: the Databases operator's pass, and `runPasses`,
  the loop both use. A pass every 30 s with the rows from
  `src/control-plane.ts`, the client of the control plane's internal API,
  which authenticates with the projected ServiceAccount token (audience
  `openupstream-control-plane`) and rereads it every pass. A pass without
  rows applies nothing.
- `src/kube.ts`: the Kubernetes calls the operators make (server-side
  apply, read a Secret, list by label, delete) behind the `Kube` interface, implemented with
  `@kubernetes/client-node`. Tests use a fake.
- `src/kubernetes.ts`: what all operators share: the Project namespace
  (`project-<project id>`) with its NetworkPolicy `project-isolation`
  (ingress only from the Project's own pods, Traefik and CloudNativePG's
  operator; ARCHITECTURE.md, decision 89), which every operator applies
  identically under one field manager before anything goes into the
  namespace, labels, the Site zone label and the third Site's taint, and
  the egress policy of customer pods (`customerEgressPolicy`).
- `deploy/`: each operator's ServiceAccount, RBAC and Deployment. The image
  is built by `Dockerfile` (GitHub Actions pushes it to
  `ghcr.io/openupstream/operators`); `infra/dev-cluster/platform.sh` deploys
  it pinned by digest.
- `scripts/`: `render-database.ts` prints a Database's manifests as YAML
  (also for a restore); `reconcile-databases.ts` runs one pass against
  `$KUBECONFIG` with rows from a JSON file or the platform's own Database
  (`--platform`, for the bootstrap). Both are for the dev cluster and
  runbooks.
- `crds/`: the upstream CRDs, vendored at the versions we run. Their types are
  generated into `src/generated/` (not checked in) by `npm run generate`;
  build, typecheck and test run it first. See `crds/README.md`.
