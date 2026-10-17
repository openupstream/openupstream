# Restore a Database to a point in time

Creates a new Database that starts as a copy of an existing one at a given
time, from the base backups and WAL on Hetzner Object Storage NBG1
(ARCHITECTURE.md, "Backups", decision 51). The source is not touched; the
restore archives into its own folder. First done on the dev cluster on
2026-10-17: restored across a failover's timeline switch, to the last row
before the target time, in about a minute.

## Needs

- The source Database's `ObjectStore` (`db-<source id>`) still exists in
  the Project's namespace, with the backup credentials Secret. That holds
  for a deleted Database too, until the backup retention window after its
  deletion has passed (ARCHITECTURE.md, decision 60), as long as its Project
  is not deleted: nothing can be created in a deleted Project. Its archive
  is `s3://<bucket>/project-<project id>/db-<source id>/`.
- A base backup older than the target time: check
  `kubectl -n project-<project id> get backups`.
- A new Database id (lowercase UUID) and name for the restored Database. Its
  row belongs in the control plane like any Database's.

## Steps

From `operators/`, with `project.json`, the new Database as `database.json`
and the platform's `config.json`:

```bash
npx tsx scripts/render-database.ts project.json database.json config.json --restore-from <source id> --target-time 2026-10-17T10:30:00Z > restore.yaml
```

The target time needs an explicit zone (`Z` or `+02:00`).

```bash
kubectl apply --server-side --field-manager=openupstream-operators --dry-run=server -f restore.yaml
```

```bash
kubectl apply --server-side --field-manager=openupstream-operators -f restore.yaml
```

```bash
kubectl -n project-<project id> wait cluster/db-<new id> --for=condition=Ready --timeout=15m
```

## Check

- The data ends at the target time: the newest row is just before it.
- `ContinuousArchiving` is `True` on the new Cluster, and its WAL lands in
  `project-<project id>/db-<new id>/`, not in the source's folder.
- Pods: primary in the Home site, standby in the other compute Site.

Afterwards the application points at the new Database's Pooler
(`db-<new id>-pooler`); the source can be deleted once the restore is
confirmed.
