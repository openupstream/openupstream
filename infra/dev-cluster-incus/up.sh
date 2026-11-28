#!/usr/bin/env bash
# Creates a three-Site k3s cluster as three Incus VMs on one machine in the
# home network (ARCHITECTURE.md, decision 137), the counterpart of
# ../dev-cluster-hetzner/up.sh for hardware of your own. Install the
# platform on it with ../dev-cluster/install-multi-node.sh; delete it with
# down.sh. Unlike the Hetzner cluster it is meant to stay: snapshot.sh saves
# and restores all three VMs together.
#
# By default the VMs carry production's Site ids (SITES in lib.sh chooses
# others):
#
#   PREFIX-hetzner-fsn1  compute Site, the default Site
#   PREFIX-ovh-lim       compute Site
#   PREFIX-netcup-nbg    no compute Site, tainted openupstream.io/quorum-only
#
# The node setup is the only place that labels the nodes (ADR-0007): the
# compute nodes join with openupstream.io/compute-site=true (the first also
# openupstream.io/default-site=true), the third with the taint
# openupstream.io/quorum-only=true:NoSchedule, and every node without a
# description gets one (openupstream.io/site-description) once it has
# joined. install-multi-node.sh only checks them. k3s sets labels only when
# a node first registers: a node that already runs k3s keeps its own.
#
# Each VM has a NIC on the host's bridge (BRIDGE), so it gets an address
# from the home router's DHCP; k3s takes it as the node's InternalIP, which
# ../dev-cluster/dns.sh puts into DNS. Each compute VM gets a second disk as
# its LVM volume group `openupstream`, where TopoLVM puts the Databases'
# volumes (infra/topolvm). Every command in a VM goes through `incus exec`,
# so no SSH key is needed.
#
# Runs where the incus CLI reaches the host: on the host itself, or on your
# machine with INCUS_REMOTE naming a remote (`incus remote add`). Needs the
# incus CLI, kubectl, openssl and jq; the host needs Incus with a storage
# pool (POOL) and a bridge on the home network (BRIDGE),
# docs/self-hosting.md section 3 says how.
# Writes: .state/ (k3s token, kubeconfig), gitignored.
set -euo pipefail

cd "$(dirname "$0")"
source ./lib.sh
STATE=.state
IMAGE=${IMAGE:-images:ubuntu/24.04/cloud}
K3S_VERSION=${K3S_VERSION:-v1.36.5+k3s1}
BRIDGE=${BRIDGE:-br0}
# Sized for a 32 GB mini PC whose integrated GPU keeps 4 GB, so Linux sees
# 28: 10 + 10 + 4 GiB, leaving about 4 GiB for the host.
COMPUTE_CPUS=${COMPUTE_CPUS:-6}
COMPUTE_MEMORY=${COMPUTE_MEMORY:-10GiB}
QUORUM_CPUS=${QUORUM_CPUS:-2}
QUORUM_MEMORY=${QUORUM_MEMORY:-4GiB}
ROOT_SIZE=${ROOT_SIZE:-60GiB}
VOLUME_SIZE=${VOLUME_SIZE:-40GiB}

[[ ${#SITES[@]} -eq 3 ]] ||
  { echo "SITES needs three Site ids: two compute Sites, then the third" >&2; exit 1; }

mkdir -p "$STATE"
chmod 700 "$STATE"
[[ -f $STATE/token ]] || openssl rand -hex 32 >"$STATE/token"

for i in 0 1 2; do
  site=${SITES[$i]}
  vm=$(instance "$site")
  if ! incus info "$vm" >/dev/null 2>&1; then
    cpus=$COMPUTE_CPUS memory=$COMPUTE_MEMORY
    [[ $site == "$QUORUM_SITE" ]] && cpus=$QUORUM_CPUS memory=$QUORUM_MEMORY
    echo "creating $vm ($cpus CPUs, $memory)"
    incus init "$IMAGE" "$vm" --vm --storage "$POOL" \
      -c limits.cpu="$cpus" -c limits.memory="$memory" \
      -c user.openupstream=dev-incus -c user.site="$site" \
      -d root,size="$ROOT_SIZE" >/dev/null
  fi
  # The devices are added on every run, so a run interrupted after `init`
  # is completed by the next one. The NIC on the home network replaces the
  # profile's (usually Incus's own NAT bridge, which the home network
  # cannot reach).
  devices=$(incus config device list "$vm")
  grep -qx eth0 <<<"$devices" ||
    incus config device add "$vm" eth0 nic nictype=bridged parent="$BRIDGE" >/dev/null
  if [[ $site != "$QUORUM_SITE" ]]; then
    volume=$(volume_name "$site")
    incus storage volume show "$R$POOL" "$volume" >/dev/null 2>&1 ||
      incus storage volume create "$R$POOL" "$volume" --type=block size="$VOLUME_SIZE" >/dev/null
    grep -qx lvm <<<"$devices" ||
      incus config device add "$vm" lvm disk pool="$POOL" source="$volume" >/dev/null
  fi
  incus start "$vm" 2>/dev/null || true
done

# The VM agent answers once the VM has booted; cloud-init finishes after it.
for site in "${SITES[@]}"; do
  vm=$(instance "$site")
  until_ok "the VM agent of $vm" incus exec "$vm" -- true 2>/dev/null
  incus exec "$vm" -- cloud-init status --wait >/dev/null || true
done

IPS=()
for site in "${SITES[@]}"; do
  vm=$(instance "$site")
  ip=
  find_ip() { ip=$(vm_state "$site" | vm_ipv4) || ip=; [[ -n $ip ]]; }
  until_ok "an IPv4 address of $vm on $BRIDGE (DHCP from the router)" find_ip
  echo "$vm: $ip"
  IPS+=("$ip")
done

# The volume group on the compute nodes, from their second disk. Incus
# gives the disk the serial incus_lvm, after the device name.
for i in 0 1; do
  site=${SITES[$i]}
  vm=$(instance "$site")
  device=
  find_disk() { device=$(incus exec "$vm" -- sh -c 'ls /dev/disk/by-id/*incus_lvm 2>/dev/null | head -n 1'); [[ -n $device ]]; }
  until_ok "the disk lvm in $vm" find_disk
  echo "volume group on $site ($device)"
  incus exec -T --env DEBIAN_FRONTEND=noninteractive "$vm" -- bash -s -- "$device" <../topolvm/vgcreate.sh
done

# Our AppArmor profile for containers, before containerd loads its own
# (ARCHITECTURE.md, decision 113; see ../dev-cluster-hetzner/up.sh).
for site in "${SITES[@]}"; do
  vm=$(instance "$site")
  if incus exec "$vm" -- test -d /sys/kernel/security/apparmor; then
    # The Incus image's kernel has AppArmor, but the image lacks its tools.
    incus exec --env DEBIAN_FRONTEND=noninteractive "$vm" -- sh -c \
      'command -v apparmor_parser >/dev/null || { apt-get update -qq && apt-get install -y -qq apparmor >/dev/null; }'
    echo "installing the AppArmor profile cri-containerd.apparmor.d on $vm"
    incus exec -T "$vm" -- sh -c 'cat >/etc/apparmor.d/cri-containerd.apparmor.d && apparmor_parser -r /etc/apparmor.d/cri-containerd.apparmor.d' \
      <../apparmor/cri-containerd.apparmor.d
  fi
done

# gVisor on the compute nodes, before k3s renders containerd's config.
for site in "${SITES[0]}" "${SITES[1]}"; do
  vm=$(instance "$site")
  incus exec "$vm" -- test -x /usr/local/bin/runsc && continue
  echo "installing gVisor on $vm"
  incus exec -T --env DEBIAN_FRONTEND=noninteractive "$vm" -- bash -s <../gvisor/install.sh
done

# The same k3s settings as on the Hetzner dev cluster, except the address:
source ../dev-cluster/k3s-server-args.sh
# the node's own on the home network is its InternalIP, and there is no
# ExternalIP. A node that already runs k3s is left alone; the installer
# would restart it.
install_k3s() { # index, extra args...
  local site=${SITES[$1]} node_ip=${IPS[$1]} vm
  vm=$(instance "$site")
  shift
  if incus exec "$vm" -- test -x /usr/local/bin/k3s; then
    echo "k3s is already installed on $vm"
    return
  fi
  echo "installing k3s on $vm ($node_ip)"
  incus exec "$vm" -- sh -c "curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION='$K3S_VERSION' K3S_TOKEN='$(cat "$STATE/token")' sh -s - server \
    $(k3s_server_args "$site" "$node_ip") \
    --node-ip $node_ip \
    $*"
}

FIRST=${IPS[0]}
COMPUTE="--node-label openupstream.io/compute-site=true --node-label openupstream.io/gvisor=true"
install_k3s 0 --cluster-init $COMPUTE --node-label openupstream.io/default-site=true
install_k3s 1 --server "https://$FIRST:6443" $COMPUTE
install_k3s 2 --server "https://$FIRST:6443" --node-taint openupstream.io/quorum-only=true:NoSchedule

incus exec "$(instance "${SITES[0]}")" -- cat /etc/rancher/k3s/k3s.yaml |
  sed "s/127.0.0.1/$FIRST/; s/: default$/: $PREFIX/" >"$STATE/kubeconfig"
chmod 600 "$STATE/kubeconfig"

# `wait --all` only waits for nodes that exist; the last one may not have
# registered yet. Each VM's hostname is its node's name.
three_nodes() {
  local site
  for site in "${SITES[@]}"; do
    KUBECONFIG=$STATE/kubeconfig kubectl get node "$PREFIX-$site" -o name >/dev/null 2>&1 || return 1
  done
}
until_ok "all three nodes to register" three_nodes
KUBECONFIG=$STATE/kubeconfig kubectl wait --for=condition=Ready node --all --timeout=5m
KUBECONFIG=$STATE/kubeconfig kubectl apply -f ../gvisor/runtimeclass.yaml >/dev/null
for site in "${SITES[@]}"; do
  [[ -n $(KUBECONFIG=$STATE/kubeconfig kubectl get node "$PREFIX-$site" -o jsonpath='{.metadata.annotations.openupstream\.io/site-description}') ]] ||
    KUBECONFIG=$STATE/kubeconfig kubectl annotate node "$PREFIX-$site" \
      openupstream.io/site-description="Incus VM $PREFIX-$site" >/dev/null
done
echo "export KUBECONFIG=$PWD/$STATE/kubeconfig"
echo "then: PLATFORM_DOMAIN=… CUSTOMER_DOMAIN=… ../dev-cluster/install-multi-node.sh"
echo "The API server is on $FIRST (${SITES[0]}); switch the kubeconfig to"
echo "another node's IP before switching that Site off."
