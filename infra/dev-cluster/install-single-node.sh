#!/usr/bin/env bash
# Installs the platform on a single-node dev cluster (ARCHITECTURE.md,
# decision 112): records the layout, then runs operators.sh, ingress.sh,
# garage.sh, monitoring.sh and platform.sh. With ALERT_EMAIL set,
# monitoring.sh also sends alerts (README).
#
# For development only: one copy of everything, no failover. Losing the
# node loses every Database, Bucket and Service on it; only the Databases'
# backups (Hetzner Object Storage) survive.
#
# The node stands in for every Site: its Site (topology.kubernetes.io/zone)
# is the only compute Site and the default Site, labelled so when it joined
# (check_sites in lib.sh checks it, ADR-0007). k3s-single-node.sh installs
# k3s that way.
#
#   PLATFORM_DOMAIN=home.example.com CUSTOMER_DOMAIN=home.example.app ./install-single-node.sh
#
# Both domains are required, each a bunny.net zone or a name inside one;
# their A records point at the node's own address, also a private one in a
# home network (docs/self-hosting.md, "A single-node dev cluster").
#
# Needs: KUBECONFIG and what the four steps need (README).
set -euo pipefail

cd "$(dirname "$0")"
source ./lib.sh
: "${PLATFORM_DOMAIN:?set PLATFORM_DOMAIN, e.g. home.example.com}"
: "${CUSTOMER_DOMAIN:?set CUSTOMER_DOMAIN, e.g. home.example.app}"

if [[ -z $(kubectl get nodes -l openupstream.io/gvisor=true -o name) ]]; then
  echo "the node needs the label openupstream.io/gvisor=true and gVisor installed;" \
    "k3s-single-node.sh sets it up so" >&2
  exit 1
fi
[[ -n $(kubectl get runtimeclass gvisor --ignore-not-found -o name) ]] ||
  { echo "no RuntimeClass gvisor: kubectl apply -f ../gvisor/runtimeclass.yaml" >&2; exit 1; }

check_sites single-node
record_layout single-node
./operators.sh
./ingress.sh
./garage.sh
./monitoring.sh
./platform.sh
