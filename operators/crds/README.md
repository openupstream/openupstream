# Vendored CRDs

The CustomResourceDefinitions the operators write objects for, copied
unchanged from upstream at pinned versions. `npm run generate -w operators`
turns each into a TypeScript type in `src/generated/` (gitignored); build,
typecheck and test run it first.

| File | Source | Version |
| --- | --- | --- |
| `postgresql.cnpg.io_clusters.yaml` | [cloudnative-pg/cloudnative-pg](https://github.com/cloudnative-pg/cloudnative-pg) `config/crd/bases/` | v1.30.1 |
| `postgresql.cnpg.io_poolers.yaml` | same | v1.30.1 |
| `postgresql.cnpg.io_scheduledbackups.yaml` | same | v1.30.1 |
| `barmancloud.cnpg.io_objectstores.yaml` | [cloudnative-pg/plugin-barman-cloud](https://github.com/cloudnative-pg/plugin-barman-cloud) `config/crd/bases/` | v0.15.1 |

Both projects are Apache-2.0. Upgrade by replacing the files with the ones of
the version installed on the cluster, updating this table and fixing whatever
no longer typechecks.
