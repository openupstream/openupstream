# dev-cluster-incus

A k3s cluster with the three Sites' layout as three Incus VMs on one
machine in your home network (ARCHITECTURE.md, decision 137). It's the
counterpart of [`infra/dev-cluster-hetzner`](../dev-cluster-hetzner/README.md)
on hardware of your own, and is meant to stay: a long-lived installation to
run apps on, test upgrades of a running cluster, and try changes of
openupstream, with `snapshot.sh` to go back.

| VM | Site | Default size |
| --- | --- | --- |
| `oup-site-1` | `site-1`, compute Site, the default Site | 6 CPUs, 10 GiB, 60 GiB disk + 40 GiB volume |
| `oup-site-2` | `site-2`, compute Site | 6 CPUs, 10 GiB, 60 GiB disk + 40 GiB volume |
| `oup-site-3` | `site-3`, no compute Site, tainted `openupstream.io/quorum-only` | 2 CPUs, 4 GiB, 60 GiB disk |

The defaults fit a host where Linux sees 28 GB of RAM, a 32 GB mini PC
whose integrated GPU keeps 4 GB (`COMPUTE_CPUS`,
`COMPUTE_MEMORY`, `QUORUM_CPUS`, `QUORUM_MEMORY`, `ROOT_SIZE`, `VOLUME_SIZE`
change them; `PREFIX`, default `oup`, the names). `SITES` chooses other
Site ids, two compute Sites and then the third (e.g.
`SITES="home-a home-b home-c"`); give the same to `down.sh` and
`snapshot.sh`. The defaults claim no location because a Site id is
permanent: it is stored in node labels, every Database, Service and Job
row and Garage's layout, so set `SITES` to choose your own once. The human
name (e.g. "Minisforum at home") is the Site's description, changed
anytime on the dashboard's "Sites & nodes" page (`/nodes`). A cluster made
before these defaults keeps its names: give it
`PREFIX=oup-home SITES="hetzner-fsn1 ovh-lim netcup-nbg"`. The compute VMs' volumes become the LVM
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
INCUS_REMOTE=um790 ./up.sh
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
Hetzner dev cluster's settings, then the RuntimeClass `gvisor`. The
compute nodes join with the label `openupstream.io/compute-site=true`,
the first also `openupstream.io/default-site=true`, the third with the
taint `openupstream.io/quorum-only`. This is the only place the nodes are
labelled; the install only checks them
([ADR-0007](../../docs/adr/0007-sites-from-node-labels.md)). k3s applies the
labels only when a node first joins: a cluster made before needs them once
by hand (the commands are in the [dev-cluster README](../dev-cluster/README.md#sites)). Run
again, it completes a VM an interrupted run left without its devices,
starts stopped VMs and installs nothing that is already there. Each wait
(VM agent, address, disk) gives up after `WAIT_SECONDS` (300).
The kubeconfig points at the first VM's address; before switching that
Site off, point it at another VM's.

Give the VMs fixed addresses in the router (DHCP reservations, after the
first run): the DNS records and the kubeconfig name them.

## Snapshots

```bash
INCUS_REMOTE=um790 ./snapshot.sh create before-upgrade
```

```bash
INCUS_REMOTE=um790 ./snapshot.sh restore before-upgrade
```

Both stop all three VMs at once and start them afterwards, so the etcd
members and each Database's two instances are saved at the same moment.
First they hibernate every Database that isn't hibernated already
(CloudNativePG's `cnpg.io/hibernation=on`: Postgres stops cleanly, volumes
and primary stay; marked with the label
`openupstream.io/snapshot-hibernated`), and afterwards they wake the marked
ones once the API and CloudNativePG's webhook answer again; a Database
hibernated on purpose stays so. If anything fails or a wait gives up, the
script still starts the VMs and wakes the Databases. Without that, a primary on a VM that stops first or boots last
fails over, and a platform Database's old primary cannot rejoin (its
archive check fails, see `../dev-cluster/README.md`); seen on the first
snapshots. They need `kubectl` and `.state/kubeconfig`. Measured on the
UM790 Pro: `create` and `restore` about 3 minutes each, then about a
minute until both instances of each Database are ready; a pod that lost
its Database meanwhile (madAuth) can sit in CrashLoopBackOff for a few
minutes more until its next try. The compute VMs' volumes are saved with
them. `list` shows the snapshots, `delete <name>` removes one.
On a ZFS pool, restoring anything but the latest snapshot needs
`zfs.remove_snapshots=true` and deletes the newer ones; btrfs has no such
limit.

## Delete

```bash
INCUS_REMOTE=um790 PLATFORM_DOMAIN=home.dev.example.com CUSTOMER_DOMAIN=home.dev.example.app ./down.sh
```

Both domains are required, as installed: without them the DNS cleanup
would take the Hetzner dev cluster's records (`SKIP_DNS=1` leaves DNS
alone). It asks first (`YES=1` skips the question), then deletes the DNS
records of the install (`../dev-cluster/dns-delete-all.sh`), the VMs with their snapshots, the volumes
and `.state/`. Only the Databases' backups survive.

`scripts.test.mjs` tests the scripts' own logic with a stubbed `incus`
(`npm run test:infra`, part of `npm test`).
