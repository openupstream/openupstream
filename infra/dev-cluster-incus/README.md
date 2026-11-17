# dev-cluster-incus

A k3s cluster with the three Sites' layout as three Incus VMs on one
machine in your home network (ARCHITECTURE.md, decision 137). It's the
counterpart of [`infra/dev-cluster-hetzner`](../dev-cluster-hetzner/README.md)
on hardware of your own, and is meant to stay: a long-lived installation to
run apps on, test upgrades of a running cluster, and try changes of
openupstream, with `snapshot.sh` to go back.

| VM | Stands in for | Default size |
| --- | --- | --- |
| `oup-home-hetzner-fsn1` | `hetzner-fsn1`, compute Site | 6 CPUs, 12 GiB, 60 GiB disk + 40 GiB volume |
| `oup-home-ovh-lim` | `ovh-lim`, compute Site | 6 CPUs, 12 GiB, 60 GiB disk + 40 GiB volume |
| `oup-home-netcup-nbg` | `netcup-nbg`, third Site, tainted `openupstream.io/third-site` | 2 CPUs, 4 GiB, 60 GiB disk |

The defaults fit a host with 32 GB of RAM (`COMPUTE_CPUS`,
`COMPUTE_MEMORY`, `THIRD_CPUS`, `THIRD_MEMORY`, `ROOT_SIZE`, `VOLUME_SIZE`
change them; `PREFIX` the names). The compute VMs' volumes become the LVM
volume group `openupstream` that TopoLVM allocates the Databases from, as
the servers' NVMe does (decision 109).

What differs from production and the Hetzner dev cluster:

- **One machine.** Stopping a VM is a Site going dark; the host failing is
  every Site at once. The VMs are about 0.1 ms apart, not 6 ms.
- **Home network addresses.** Each VM has a NIC on the host's bridge and
  gets its address from the router. It's the node's InternalIP, with no
  ExternalIP, so `dns.sh` puts the private addresses into DNS. bunny.net
  cannot health-check them, so a dark Site's address stays in DNS
  (decision 137). Nothing is reachable from the internet.
- **No SSH.** Every command in a VM goes through `incus exec`.

The host's setup (Ubuntu, Incus, the bridge, a storage pool, the remote
for your machine, the router's DNS rebinding exception) is in
[docs/self-hosting.md](../../docs/self-hosting.md), section 3.

## Use

On the host, or on your machine with `INCUS_REMOTE` naming the host's
Incus remote:

```bash
INCUS_REMOTE=mini ./up.sh
```

```bash
export KUBECONFIG=$PWD/.state/kubeconfig
```

```bash
PLATFORM_DOMAIN=home.dev.example.com CUSTOMER_DOMAIN=home.dev.example.app CLUSTER_ISSUER=letsencrypt ../dev-cluster/install-multi-node.sh
```

Set both domains: without them `install-multi-node.sh` takes the Hetzner
dev cluster's (`dev.openupstream.com`, `dev.openupstream.app`) and points
them here. Each is a bunny.net zone or a name inside one, as for a single
node. `CLUSTER_ISSUER=letsencrypt` gives certificates that browsers and
Services trust, instead of the staging ones the multi-node default issues
for a throwaway cluster. Custom domains get no certificate while nothing
is reachable from the internet: their HTTP-01 challenge must reach port 80.

`up.sh` creates the VMs (Ubuntu 24.04, `IMAGE`) on the storage pool `POOL`
(default `default`) with a NIC on `BRIDGE` (default `br0`), the volume
group on the compute VMs (`infra/topolvm/vgcreate.sh`), our AppArmor
profile, gVisor on the compute VMs (`infra/gvisor`), and k3s with the
Hetzner dev cluster's settings, then the RuntimeClass `gvisor`. Run
again, it starts stopped VMs and installs nothing that is already there.
The kubeconfig points at `hetzner-fsn1`'s address; before switching that
Site off, point it at another VM's.

Give the VMs fixed addresses in the router (DHCP reservations, after the
first run): the DNS records and the kubeconfig name them.

## Snapshots

```bash
INCUS_REMOTE=mini ./snapshot.sh create before-upgrade
```

```bash
INCUS_REMOTE=mini ./snapshot.sh restore before-upgrade
```

Both stop all three VMs first and start them afterwards, so the etcd
members and each Database's two instances are saved at the same moment;
the cluster is down for a minute or two. The compute VMs' volumes are
saved with them. `list` shows the snapshots, `delete <name>` removes one.
On a ZFS pool, restoring anything but the latest snapshot needs
`zfs.remove_snapshots=true` and deletes the newer ones; btrfs has no such
limit.

## Delete

```bash
INCUS_REMOTE=mini ./down.sh
```

It asks first (`YES=1` skips the question), then deletes the DNS records of
the install (`../dev-cluster/dns-delete-all.sh`, with `PLATFORM_DOMAIN` and
`CUSTOMER_DOMAIN` as installed), the VMs with their snapshots, the volumes
and `.state/`. Only the Databases' backups survive.

`scripts.test.mjs` tests the scripts' own logic with a stubbed `incus`
(`npm run test:infra`, part of `npm test`).
