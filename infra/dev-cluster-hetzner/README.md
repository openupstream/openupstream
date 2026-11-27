# dev-cluster-hetzner

A throwaway k3s cluster with the three Sites' layout, for one working
session (ARCHITECTURE.md, decisions 33 and 52). Three Hetzner Cloud VMs
stand in for the Sites; by default the nodes carry production's Site ids
(`SITES` and `LOCATIONS`, space-separated, choose others; the first two are
the compute Sites):

| Node | Location | Stands in for |
| --- | --- | --- |
| `oup-dev-hetzner-fsn1` | fsn1 | `hetzner-fsn1`, compute Site, the default Site |
| `oup-dev-ovh-lim` | hel1 | `ovh-lim`, compute Site (Hetzner Cloud has no Limburg) |
| `oup-dev-netcup-nbg` | nbg1 | `netcup-nbg`, third Site, tainted `openupstream.io/third-site` |

Three `cpx32` cost about €0.20 an hour together (gross, October 2026). The
two compute VMs each get a 40 GB Hetzner Cloud Volume as the LVM volume
group `openupstream`, where TopoLVM puts the Databases' volumes, as on the
servers' NVMe (decision 109); both cost about €0.005 an hour. `down.sh`
deletes them with the VMs. These scripts create and delete the VMs only; the platform is installed
onto them by [`infra/dev-cluster`](../dev-cluster/README.md) in its
`multi-node` layout, which also runs on any other cluster with nodes in
three or more Sites. For one machine instead, see its single-node layout.

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
gVisor on the two compute nodes (`infra/gvisor`), their volumes with the
volume group (`infra/topolvm/vgcreate.sh`), and k3s with embedded
etcd and flannel `wireguard-native`, each node's public address as its
ExternalIP (which `dns.sh` puts into DNS), then the RuntimeClass `gvisor`.
The compute nodes join with the label `openupstream.io/compute-site=true`,
the first also `openupstream.io/default-site=true`, the third with the
taint `openupstream.io/third-site`, and each node without a description
gets `Hetzner Cloud <location>`. This is the only place the nodes are
labelled; the install only checks them
([ADR-0007](../../docs/adr/0007-sites-from-node-labels.md),
[dev-cluster README](../dev-cluster/README.md#sites)).

The kubeconfig points at the first node (`hetzner-fsn1`). Before switching that Site
off, point it at another node's IP (all three serve the API).

When done:

```bash
./down.sh
```

It deletes the DNS records in both zones (through `../dev-cluster/dns-delete-all.sh`;
`PLATFORM_DOMAIN` and `CUSTOMER_DOMAIN` if you set others), the VMs and
their volumes, the firewall, the SSH key and `.state/`. Backups the session wrote stay in the
bucket; Buckets lived on the VMs and are gone with them.
