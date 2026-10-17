#!/usr/bin/env bash
# Creates a throwaway three-Site k3s cluster on Hetzner Cloud for one working
# session (ARCHITECTURE.md decision #33). Destroy it with down.sh.
#
# Cloud locations stand in for the Sites; nodes carry the real Site names, so
# the operators' manifests apply unchanged:
#
#   hetzner-fsn1  fsn1  compute Site
#   ovh-lim       hel1  compute Site (stand-in; Hetzner Cloud has no Limburg)
#   netcup-nbg    nbg1  third Site, tainted openupstream.io/third-site
#
# Needs: hcloud with an active context, kubectl, ssh, curl, openssl.
# Writes: .state/ (SSH key, k3s token, kubeconfig), gitignored.
set -euo pipefail

cd "$(dirname "$0")"
STATE=.state
PREFIX=${PREFIX:-oup-dev}
LABEL="openupstream=dev"
SERVER_TYPE=${SERVER_TYPE:-cpx32}
IMAGE=${IMAGE:-ubuntu-24.04}
K3S_VERSION=${K3S_VERSION:-v1.36.5+k3s1}
SITES=(hetzner-fsn1 ovh-lim netcup-nbg)
location() {
  case $1 in
    hetzner-fsn1) echo fsn1 ;;
    ovh-lim) echo hel1 ;;
    netcup-nbg) echo nbg1 ;;
  esac
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
# API only from here (Tailscale replaces this on the real cluster).
nodes_json=$(printf '"%s/32",' "${IPS[@]}" | sed 's/,$//')
cat >"$STATE/firewall.json" <<EOF
[
  {"direction": "in", "protocol": "icmp", "source_ips": ["0.0.0.0/0", "::/0"]},
  {"direction": "in", "protocol": "tcp", "port": "22", "source_ips": ["$ADMIN_IP/32"]},
  {"direction": "in", "protocol": "tcp", "port": "6443", "source_ips": ["$ADMIN_IP/32"]},
  {"direction": "in", "protocol": "tcp", "port": "any", "source_ips": [$nodes_json]},
  {"direction": "in", "protocol": "udp", "port": "any", "source_ips": [$nodes_json]}
]
EOF
hcloud firewall describe "$PREFIX" >/dev/null 2>&1 ||
  hcloud firewall create --name "$PREFIX" --label "$LABEL" >/dev/null
hcloud firewall replace-rules "$PREFIX" --rules-file "$STATE/firewall.json" >/dev/null
hcloud firewall apply-to-resource "$PREFIX" --type label_selector --label-selector "$LABEL" >/dev/null 2>&1 || true

for node_ip in "${IPS[@]}"; do
  until "${SSH[@]}" "root@$node_ip" true 2>/dev/null; do sleep 3; done
done

# A dark node is marked NotReady after 20 s instead of 50 s, and its pods
# are replaced 30 s later instead of 300 s, so a dark Site's Services and
# system pods move within about a minute (ARCHITECTURE.md, decision 46).
install_k3s() { # site, ip, extra args...
  local site=$1 node_ip=$2
  shift 2
  echo "installing k3s on $site ($node_ip)"
  "${SSH[@]}" "root@$node_ip" "curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION='$K3S_VERSION' K3S_TOKEN='$(cat "$STATE/token")' sh -s - server \
    --flannel-backend=wireguard-native \
    --node-label topology.kubernetes.io/zone=$site \
    --tls-san $node_ip \
    --secrets-encryption \
    --kube-apiserver-arg default-not-ready-toleration-seconds=30 \
    --kube-apiserver-arg default-unreachable-toleration-seconds=30 \
    --kube-controller-manager-arg node-monitor-grace-period=20s \
    --disable traefik --disable servicelb \
    $*"
}

FIRST=${IPS[0]}
install_k3s "${SITES[0]}" "$FIRST" --cluster-init
install_k3s "${SITES[1]}" "${IPS[1]}" --server "https://$FIRST:6443"
install_k3s "${SITES[2]}" "${IPS[2]}" --server "https://$FIRST:6443" \
  --node-taint openupstream.io/third-site=true:NoSchedule

"${SSH[@]}" "root@$FIRST" cat /etc/rancher/k3s/k3s.yaml |
  sed "s/127.0.0.1/$FIRST/; s/: default$/: $PREFIX/" >"$STATE/kubeconfig"
chmod 600 "$STATE/kubeconfig"

KUBECONFIG=$STATE/kubeconfig kubectl wait --for=condition=Ready node --all --timeout=5m
echo "export KUBECONFIG=$PWD/$STATE/kubeconfig"
echo "The API server is on $FIRST (hetzner-fsn1); switch the kubeconfig to"
echo "another node's IP before switching that Site off."
