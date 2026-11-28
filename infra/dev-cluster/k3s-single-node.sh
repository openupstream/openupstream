#!/usr/bin/env bash
# Sets up one Linux machine as a single-node dev cluster over SSH
# (ARCHITECTURE.md, decision 112), the counterpart of
# infra/dev-cluster-hetzner/up.sh for any machine you can reach:
#
# 1. on a machine with AppArmor, our profile for containers
#    (infra/apparmor/cri-containerd.apparmor.d), on every run: without it
#    Ubuntu 26.04 keeps a container's processes from signalling each other
#    and Postgres never starts (decision 113);
# 2. gVisor (infra/gvisor/install.sh), before k3s first starts;
# 3. k3s as a single server with the same settings as on the Hetzner dev
#    cluster, the node labelled with its Site SITE (default site-1)
#    as the compute and default Site (ADR-0007), and for gVisor;
# 4. the RuntimeClass gvisor, and the kubeconfig in .state/kubeconfig.
#
#   ./k3s-single-node.sh root@192.168.1.50
#
# SITE is the node's Site id (default site-1), e.g. SITE=home. It is
# set when k3s first registers the node; the platform's data names it as
# the Home site, so it stays: choose it once. An admin names the Site on
# the dashboard's "Sites & nodes" page. This script is the only place that labels the node (ADR-0007);
# install-single-node.sh only checks it.
#
# Then install the platform with install-single-node.sh. Running it again
# on a machine that already has k3s installs nothing and only fetches the
# kubeconfig again: both installers restart a running k3s, which on a single
# node stops everything. REINSTALL=1 installs both again anyway, e.g. for a
# new K3S_VERSION. k3s's own uninstall script
# (/usr/local/bin/k3s-uninstall.sh on the machine) removes everything.
#
# The kubeconfig uses the host name ssh resolves the target to (its
# HostName, for an alias in ~/.ssh/config); HOST overrides it.
#
# NODE_ADDRESS, if set, becomes the node's ExternalIP, the address dns.sh
# puts into DNS instead of the one k3s picks (the default route's, usually
# the home network's); on a machine that already has k3s with another
# ExternalIP the script refuses it unless REINSTALL=1. Not yet tested
# across a reboot that starts k3s before Tailscale. For a machine reached
# over Tailscale only:
#
#   NODE_ADDRESS=$(ssh root@minisforum tailscale ip -4) ./k3s-single-node.sh root@minisforum
#
# Needs: an x86_64 Linux machine (gVisor is pinned for x86_64) with ports
# 80, 443 and 6443 free, SSH as root or as a user with passwordless sudo,
# and kubectl here.
set -euo pipefail

cd "$(dirname "$0")"
source ./lib.sh
TARGET=${1:?usage: ./k3s-single-node.sh <user@host>}
# The Site id; k3s sets node labels only when it registers the node.
SITE=${SITE:-site-1}
valid_site_id "$SITE" ||
  { echo "SITE must be a label value: letters, digits, '-', '_' and '.', at most 63: $SITE" >&2; exit 1; }
HOST=${HOST:-$(ssh -G "$TARGET" | awk '$1 == "hostname" {print $2}')}
STATE=${STATE:-.state}
K3S_VERSION=${K3S_VERSION:-v1.36.5+k3s1}
SSH=(ssh -o ConnectTimeout=10 "$TARGET")
SUDO="sudo -n"
[[ $TARGET == root@* ]] && SUDO=

mkdir -p "$STATE"
chmod 700 "$STATE"

# Into /etc/apparmor.d, so it is loaded at boot before k3s, and loaded now;
# replacing it applies to running containers without a restart.
if "${SSH[@]}" test -d /sys/kernel/security/apparmor; then
  echo "installing the AppArmor profile cri-containerd.apparmor.d on $HOST"
  "${SSH[@]}" "$SUDO tee /etc/apparmor.d/cri-containerd.apparmor.d >/dev/null && $SUDO apparmor_parser -r /etc/apparmor.d/cri-containerd.apparmor.d" \
    <../apparmor/cri-containerd.apparmor.d
fi

if [[ ${REINSTALL:-} != 1 ]] && "${SSH[@]}" test -x /usr/local/bin/k3s; then
  echo "k3s is already installed on $HOST; installing nothing (REINSTALL=1 to install again)"
  # k3s takes NODE_ADDRESS only when installed; refuse to ignore it.
  if [[ -n ${NODE_ADDRESS:-} ]]; then
    current=$("${SSH[@]}" "$SUDO k3s kubectl get nodes -o jsonpath='{.items[0].status.addresses[?(@.type==\"ExternalIP\")].address}'")
    if [[ " $current " != *" $NODE_ADDRESS "* ]]; then
      echo "the node's ExternalIP is '${current:-none}', not $NODE_ADDRESS;" \
        "REINSTALL=1 NODE_ADDRESS=$NODE_ADDRESS installs k3s again with it (restarts k3s)" >&2
      exit 1
    fi
  fi
else
  echo "installing gVisor on $HOST"
  "${SSH[@]}" $SUDO bash -s <../gvisor/install.sh

  # No wireguard (no traffic between nodes) and no shortened eviction times
  # (no other node to move pods to); the rest as in up.sh.
  echo "installing k3s on $HOST"
  "${SSH[@]}" "curl -sfL https://get.k3s.io | $SUDO env INSTALL_K3S_VERSION='$K3S_VERSION' sh -s - server \
  --node-label $ZONE_LABEL=$SITE \
  --node-label $COMPUTE_LABEL=true \
  --node-label $DEFAULT_LABEL=true \
  --node-label openupstream.io/gvisor=true \
  --tls-san $HOST \
  ${NODE_ADDRESS:+--node-external-ip $NODE_ADDRESS} \
  --secrets-encryption \
  --disable traefik --disable servicelb"
fi

"${SSH[@]}" $SUDO cat /etc/rancher/k3s/k3s.yaml |
  sed "s/127.0.0.1/$HOST/; s/: default$/: oup-single-node/" >"$STATE/kubeconfig"
chmod 600 "$STATE/kubeconfig"

KUBECONFIG=$STATE/kubeconfig kubectl wait --for=condition=Ready node --all --timeout=5m
KUBECONFIG=$STATE/kubeconfig kubectl apply -f ../gvisor/runtimeclass.yaml >/dev/null
echo "export KUBECONFIG=$PWD/$STATE/kubeconfig"
echo "then: PLATFORM_DOMAIN=… CUSTOMER_DOMAIN=… ./install-single-node.sh"
