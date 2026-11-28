#!/usr/bin/env bash
# Creates a throwaway three-Site k3s cluster on Hetzner Cloud for one working
# session (ARCHITECTURE.md decisions 33 and 52). Install the platform on it
# with ../dev-cluster/install-multi-node.sh; destroy it with down.sh.
#
# Cloud locations stand in for the Sites. By default the nodes carry
# production's Site ids, so the platform's data looks like production's
# (SITES and LOCATIONS, space-separated, choose others; the first two are
# the compute Sites):
#
#   hetzner-fsn1  fsn1  compute Site, the default Site
#   ovh-lim       hel1  compute Site (stand-in; Hetzner Cloud has no Limburg)
#   netcup-nbg    nbg1  no compute Site, tainted openupstream.io/quorum-only
#
# The node setup is the only place that labels the nodes (ADR-0007): the
# compute nodes join with openupstream.io/compute-site=true (the first also
# openupstream.io/default-site=true), the third with the taint
# openupstream.io/quorum-only=true:NoSchedule, and every node without a
# description gets one (openupstream.io/site-description) once it has
# joined. install-multi-node.sh only checks them. k3s sets labels only when
# a node first registers: a node that already runs k3s keeps its own.
#
# Each compute node gets a Hetzner Cloud Volume as its LVM volume group
# `openupstream`, where TopoLVM puts the Databases' volumes (infra/topolvm);
# on the real servers it is their NVMe.
#
# Needs: hcloud with an active context, kubectl, ssh, curl, openssl, jq.
# Writes: .state/ (SSH key, k3s token, kubeconfig), gitignored.
set -euo pipefail

cd "$(dirname "$0")"
STATE=.state
PREFIX=${PREFIX:-oup-dev}
LABEL="openupstream=dev"
SERVER_TYPE=${SERVER_TYPE:-cpx32}
IMAGE=${IMAGE:-ubuntu-24.04}
K3S_VERSION=${K3S_VERSION:-v1.36.5+k3s1}
VOLUME_GB=${VOLUME_GB:-40}
read -r -a SITES <<<"${SITES:-hetzner-fsn1 ovh-lim netcup-nbg}"
read -r -a LOCATIONS <<<"${LOCATIONS:-fsn1 hel1 nbg1}"
[[ ${#SITES[@]} -eq 3 && ${#LOCATIONS[@]} -eq 3 ]] ||
  { echo "SITES and LOCATIONS each need three entries: two compute Sites, then the third" >&2; exit 1; }
location() { # site → its Hetzner Cloud location
  local i
  for i in 0 1 2; do [[ ${SITES[$i]} == "$1" ]] && echo "${LOCATIONS[$i]}"; done
  return 0
}

mkdir -p "$STATE"
chmod 700 "$STATE"
SSH=(ssh -i "$STATE/id_ed25519" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$STATE/known_hosts" -o ConnectTimeout=10)

[[ -f $STATE/id_ed25519 ]] || ssh-keygen -q -t ed25519 -N '' -C "$PREFIX" -f "$STATE/id_ed25519"
[[ -f $STATE/token ]] || openssl rand -hex 32 >"$STATE/token"

hcloud ssh-key describe "$PREFIX" >/dev/null 2>&1 ||
  hcloud ssh-key create --name "$PREFIX" --public-key-from-file "$STATE/id_ed25519.pub" --label "$LABEL" >/dev/null

for site in "${SITES[@]}"; do
  name="$PREFIX-$site"
  hcloud server describe "$name" >/dev/null 2>&1 && continue
  echo "creating $name in $(location "$site")"
  hcloud server create --name "$name" --type "$SERVER_TYPE" --image "$IMAGE" \
    --location "$(location "$site")" --ssh-key "$PREFIX" \
    --label "$LABEL" --label "site=$site" >/dev/null
done

ip() { hcloud server ip "$PREFIX-$1"; }
IPS=()
for site in "${SITES[@]}"; do IPS+=("$(ip "$site")"); done
ADMIN_IP=$(curl -fsS -4 https://ifconfig.me)

# The node-to-node ports only from the other nodes; SSH and the Kubernetes
# API only from here (Tailscale replaces this on the real cluster); HTTP and
# HTTPS from everywhere, for Traefik (ingress.sh).
nodes_json=$(printf '"%s/32",' "${IPS[@]}" | sed 's/,$//')
cat >"$STATE/firewall.json" <<EOF
[
  {"direction": "in", "protocol": "icmp", "source_ips": ["0.0.0.0/0", "::/0"]},
  {"direction": "in", "protocol": "tcp", "port": "22", "source_ips": ["$ADMIN_IP/32"]},
  {"direction": "in", "protocol": "tcp", "port": "6443", "source_ips": ["$ADMIN_IP/32"]},
  {"direction": "in", "protocol": "tcp", "port": "80", "source_ips": ["0.0.0.0/0", "::/0"]},
  {"direction": "in", "protocol": "tcp", "port": "443", "source_ips": ["0.0.0.0/0", "::/0"]},
  {"direction": "in", "protocol": "tcp", "port": "any", "source_ips": [$nodes_json]},
  {"direction": "in", "protocol": "udp", "port": "any", "source_ips": [$nodes_json]}
]
EOF
hcloud firewall describe "$PREFIX" >/dev/null 2>&1 ||
  hcloud firewall create --name "$PREFIX" --label "$LABEL" >/dev/null
hcloud firewall replace-rules "$PREFIX" --rules-file "$STATE/firewall.json" >/dev/null
# Applied by label, so it also covers servers created on a re-run.
hcloud firewall describe "$PREFIX" -o json |
  jq -e --arg label "$LABEL" '.applied_to[]? | select(.label_selector.selector == $label)' >/dev/null ||
  hcloud firewall apply-to-resource "$PREFIX" --type label_selector --label-selector "$LABEL" >/dev/null

for node_ip in "${IPS[@]}"; do
  until "${SSH[@]}" "root@$node_ip" true 2>/dev/null; do sleep 3; done
done

# The volume group on the compute nodes, from a volume of their own; down.sh
# deletes the volumes by label, as it does the servers.
for i in 0 1; do
  site=${SITES[$i]}
  name="$PREFIX-$site"
  hcloud volume describe "$name" >/dev/null 2>&1 ||
    hcloud volume create --name "$name" --size "$VOLUME_GB" --server "$name" --label "$LABEL" >/dev/null
  device=$(hcloud volume describe "$name" -o json | jq -r .linux_device)
  until "${SSH[@]}" "root@${IPS[$i]}" test -b "$device"; do sleep 2; done
  echo "volume group on $site ($device)"
  "${SSH[@]}" "root@${IPS[$i]}" bash -s -- "$device" <../topolvm/vgcreate.sh
done

# The node's public address is its ExternalIP, which dns.sh puts into DNS.
source ../dev-cluster/k3s-server-args.sh
install_k3s() { # site, ip, extra args...
  local site=$1 node_ip=$2
  shift 2
  echo "installing k3s on $site ($node_ip)"
  "${SSH[@]}" "root@$node_ip" "curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION='$K3S_VERSION' K3S_TOKEN='$(cat "$STATE/token")' sh -s - server \
    $(k3s_server_args "$site" "$node_ip") \
    --node-external-ip $node_ip \
    $*"
}

# Our AppArmor profile for containers on every node with AppArmor, before
# containerd loads its own: without it Ubuntu 26.04 (IMAGE=ubuntu-26.04)
# keeps a container's processes from signalling each other and Postgres
# never starts (ARCHITECTURE.md, decision 113).
for node_ip in "${IPS[@]}"; do
  if "${SSH[@]}" "root@$node_ip" test -d /sys/kernel/security/apparmor; then
    echo "installing the AppArmor profile cri-containerd.apparmor.d on $node_ip"
    "${SSH[@]}" "root@$node_ip" "tee /etc/apparmor.d/cri-containerd.apparmor.d >/dev/null && apparmor_parser -r /etc/apparmor.d/cri-containerd.apparmor.d" \
      <../apparmor/cri-containerd.apparmor.d
  fi
done

# gVisor on the compute nodes, before k3s renders containerd's config at its
# first start; the label lets the RuntimeClass gvisor schedule only there.
for node_ip in "${IPS[0]}" "${IPS[1]}"; do
  echo "installing gVisor on $node_ip"
  "${SSH[@]}" "root@$node_ip" bash -s <../gvisor/install.sh
done

FIRST=${IPS[0]}
COMPUTE="--node-label openupstream.io/compute-site=true --node-label openupstream.io/gvisor=true"
install_k3s "${SITES[0]}" "$FIRST" --cluster-init $COMPUTE --node-label openupstream.io/default-site=true
install_k3s "${SITES[1]}" "${IPS[1]}" --server "https://$FIRST:6443" $COMPUTE
install_k3s "${SITES[2]}" "${IPS[2]}" --server "https://$FIRST:6443" \
  --node-taint openupstream.io/quorum-only=true:NoSchedule

"${SSH[@]}" "root@$FIRST" cat /etc/rancher/k3s/k3s.yaml |
  sed "s/127.0.0.1/$FIRST/; s/: default$/: $PREFIX/" >"$STATE/kubeconfig"
chmod 600 "$STATE/kubeconfig"

KUBECONFIG=$STATE/kubeconfig kubectl wait --for=condition=Ready node --all --timeout=5m
KUBECONFIG=$STATE/kubeconfig kubectl apply -f ../gvisor/runtimeclass.yaml >/dev/null
# The node's name is its server's.
for site in "${SITES[@]}"; do
  [[ -n $(KUBECONFIG=$STATE/kubeconfig kubectl get node "$PREFIX-$site" -o jsonpath='{.metadata.annotations.openupstream\.io/site-description}') ]] ||
    KUBECONFIG=$STATE/kubeconfig kubectl annotate node "$PREFIX-$site" \
      openupstream.io/site-description="Hetzner Cloud $(location "$site")" >/dev/null
done
echo "export KUBECONFIG=$PWD/$STATE/kubeconfig"
echo "then: ../dev-cluster/install-multi-node.sh"
echo "The API server is on $FIRST (${SITES[0]}); switch the kubeconfig to"
echo "another node's IP before switching that Site off."
