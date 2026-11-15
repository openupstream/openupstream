#!/usr/bin/env bash
# Sets up one Linux machine as a single-node dev cluster over SSH
# (ARCHITECTURE.md, decision 109), the counterpart of
# infra/dev-cluster-hetzner/up.sh for any machine you can reach:
#
# 1. on a machine with AppArmor, our profile for containers
#    (infra/apparmor/cri-containerd.apparmor.d), on every run: without it
#    Ubuntu 26.04 keeps a container's processes from signalling each other
#    and Postgres never starts (decision 110);
# 2. gVisor (infra/gvisor/install.sh), before k3s first starts;
# 3. k3s as a single server with the same settings as on the Hetzner dev
#    cluster, the node labelled as the compute Site hetzner-fsn1 and for
#    gVisor;
# 4. the RuntimeClass gvisor, and the kubeconfig in .state/kubeconfig.
#
#   ./k3s-single-node.sh root@192.168.1.50
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
# the home network's). For a machine reached over Tailscale only:
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
else
  echo "installing gVisor on $HOST"
  "${SSH[@]}" $SUDO bash -s <../gvisor/install.sh

  # No wireguard (no traffic between nodes) and no shortened eviction times
  # (no other node to move pods to); the rest as in up.sh.
  echo "installing k3s on $HOST"
  "${SSH[@]}" "curl -sfL https://get.k3s.io | $SUDO env INSTALL_K3S_VERSION='$K3S_VERSION' sh -s - server \
  --node-label topology.kubernetes.io/zone=$SINGLE_NODE_SITE \
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
