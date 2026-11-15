# dev-cluster-hetzner

A throwaway k3s cluster with the three Sites' layout, for one working
session (ARCHITECTURE.md, decisions 33 and 52). Three Hetzner Cloud VMs
stand in for the Sites; the nodes carry the real Site names:

| Node | Location | Stands in for |
| --- | --- | --- |
| `oup-dev-hetzner-fsn1` | fsn1 | `hetzner-fsn1`, compute Site |
| `oup-dev-ovh-lim` | hel1 | `ovh-lim`, compute Site (Hetzner Cloud has no Limburg) |
| `oup-dev-netcup-nbg` | nbg1 | `netcup-nbg`, third Site, tainted `openupstream.io/third-site` |

Three `cpx32` cost about €0.20 an hour together (gross, October 2026).
These scripts create and delete the VMs only; the platform is installed
onto them by [`infra/dev-cluster`](../dev-cluster/README.md) in its
`multi-node` layout, which also runs on any other cluster with one node per
Site. For one machine instead, see its single-node layout.

## Use

Needs `hcloud` with a context for the dev Cloud project, `kubectl`, `ssh`,
`curl`, `openssl` and `jq` ([docs/self-hosting.md](../../docs/self-hosting.md),
section 3), and for the install what `infra/dev-cluster` lists.

```bash
./up.sh
```

```bash
export KUBECONFIG=$PWD/.state/kubeconfig
```

```bash
../dev-cluster/install-multi-node.sh
```

`up.sh` creates the VMs, a firewall (SSH and the Kubernetes API only from
your IP, HTTP and HTTPS from everywhere, everything between the nodes),
gVisor on the two compute nodes (`infra/gvisor`), and k3s with embedded
etcd and flannel `wireguard-native`, then the RuntimeClass `gvisor`.

The kubeconfig points at the `hetzner-fsn1` node. Before switching that Site
off, point it at another node's IP (all three serve the API).

When done:

```bash
./down.sh
```

It deletes the DNS records in both zones (through `../dev-cluster/dns.sh`;
`PLATFORM_DOMAIN` and `CUSTOMER_DOMAIN` if you set others), the VMs, the
firewall, the SSH key and `.state/`. Backups the session wrote stay in the
bucket; Buckets lived on the VMs and are gone with them.
