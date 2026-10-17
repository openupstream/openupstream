# dev-cluster

A throwaway k3s cluster with the three Sites' layout, for one working
session (ARCHITECTURE.md, decisions 33 and 52). Three Hetzner Cloud VMs
stand in for the Sites; the nodes carry the real Site names:

| Node | Location | Stands in for |
| --- | --- | --- |
| `oup-dev-hetzner-fsn1` | fsn1 | `hetzner-fsn1`, compute Site |
| `oup-dev-ovh-lim` | hel1 | `ovh-lim`, compute Site (Hetzner Cloud has no Limburg) |
| `oup-dev-netcup-nbg` | nbg1 | `netcup-nbg`, third Site, tainted `openupstream.io/third-site` |

Three `cpx32` cost about €0.20 an hour together (gross, October 2026). Storage is k3s's
local-path provisioner, not TopoLVM.

## Use

Needs `hcloud` with a context for the dev Cloud project, `kubectl`, and the
AWS CLI profile `openupstream-backup` with the S3 keys of the backup project
on Hetzner Object Storage.

```bash
./up.sh
```

```bash
export KUBECONFIG=$PWD/.state/kubeconfig
```

```bash
./operators.sh
```

`up.sh` creates the VMs, a firewall (SSH and the Kubernetes API only from
your IP, everything between the nodes) and k3s with embedded etcd and
flannel `wireguard-native`. `operators.sh` installs cert-manager,
CloudNativePG and the Barman Cloud Plugin at the versions in
`operators/crds`, spreads CoreDNS and the CloudNativePG operator over the
compute Sites, and creates the backup credentials Secret in
`openupstream-system`. Then, from `operators/`:

```bash
npx tsx scripts/reconcile-databases.ts rows.json config.json --dry-run
```

where `rows.json` is `[{ "project": …, "database": … }]` and `config.json` a
`DatabaseConfig` (storage class `local-path`).

The kubeconfig points at the `hetzner-fsn1` node. Before switching that Site
off, point it at another node's IP (all three serve the API).

When done:

```bash
./down.sh
```

It deletes the VMs, the firewall, the SSH key and `.state/`. Backups the
session wrote stay in the bucket.
