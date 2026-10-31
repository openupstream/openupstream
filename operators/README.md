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
  turns rows into the objects to apply: per Project its namespace and a copy
  of the backup credentials Secret, then each Database's objects.
  `reconcileDatabases` applies them with server-side apply. It never deletes
  (ARCHITECTURE.md, decision 48).
- `src/routes/`: the Routes operator (ARCHITECTURE.md, decision 84).
  `planRoutes` (pure) turns the routing table into, per Project, its
  namespace, an ExternalName Service to Garage's website endpoint and the
  shared Middlewares (compression, HSTS); per Route, a Middleware that sets
  the Host header to the Bucket's name and one that strips the prefix; per
  Domain, an IngressRoute on the default certificate. `reconcileRoutes`
  applies them and deletes the objects labelled
  `openupstream.io/component=routes` that are no longer wanted. A pass
  without the routing table applies and deletes nothing.
- `src/main.ts`: the image's entry point; `OPERATOR` (`databases`, the
  default, or `routes`) picks which operator the process runs, each in its
  own Deployment with its own ServiceAccount.
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
  (`project-<project id>`) and its manifest, which both apply identically
  under one field manager, labels, the Site zone label and the third Site's
  taint.
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
