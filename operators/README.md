# operators

Kubernetes reconcilers written in TypeScript. They watch the control plane's
desired state and the cluster's actual state and close the gap.

Kept deliberately thin: every behaviour that CloudNativePG, cert-manager or
Traefik already implements is configured, not reimplemented.

## Layout

- `src/databases/manifests.ts`: a Database → its CloudNativePG `Cluster`,
  PgBouncer `Pooler`, Barman Cloud `ObjectStore` and `ScheduledBackup`. Pure
  functions; invalid input comes back as a list of errors.
- `src/kubernetes.ts`: what all operators share: the Project namespace
  (`project-<project id>`), labels, the Site zone label and the third Site's
  taint.
- `crds/`: the upstream CRDs, vendored at the versions we run. Their types are
  generated into `src/generated/` (not checked in) by `npm run generate`;
  build, typecheck and test run it first. See `crds/README.md`.

No reconcile loop and no Kubernetes client yet: those come with the first
cluster to test against.
