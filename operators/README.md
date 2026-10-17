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
- `src/kube.ts`: the two Kubernetes calls the operators make (server-side
  apply, read a Secret) behind the `Kube` interface, implemented with
  `@kubernetes/client-node`. Tests use a fake.
- `src/kubernetes.ts`: what all operators share: the Project namespace
  (`project-<project id>`), labels, the Site zone label and the third Site's
  taint.
- `deploy/`: each operator's ServiceAccount and RBAC.
- `scripts/`: `render-database.ts` prints a Database's manifests as YAML
  (also for a restore); `reconcile-databases.ts` runs one pass against
  `$KUBECONFIG` with rows from a JSON file, until the control plane serves
  them (decision 49). Both are for the dev cluster and runbooks.
- `crds/`: the upstream CRDs, vendored at the versions we run. Their types are
  generated into `src/generated/` (not checked in) by `npm run generate`;
  build, typecheck and test run it first. See `crds/README.md`.

Not yet: the operator running in the cluster, on a timer or watch, with rows
from the control plane.
