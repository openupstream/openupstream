#!/usr/bin/env bash
# Installs the platform on a single-node dev cluster (ARCHITECTURE.md,
# decision 112): records the layout, then runs operators.sh, ingress.sh,
# garage.sh and platform.sh. monitoring.sh is a separate step (README).
#
# For development only: one copy of everything, no failover. Losing the
# node loses every Database, Bucket and Service on it; only the Databases'
# backups (Hetzner Object Storage) survive.
#
# The node stands in for every Site: it carries the label of the compute
# Site hetzner-fsn1, and a Database or Service with the Home site ovh-lim
# runs there as well. k3s-single-node.sh installs k3s that way.
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

nodes=$(kubectl get nodes -o name | wc -l | tr -d ' ')
if [[ $nodes -ne 1 ]]; then
  echo "the cluster has $nodes nodes; install-single-node.sh needs exactly one" \
    "(install-multi-node.sh is for one node per Site)" >&2
  exit 1
fi
if [[ -z $(kubectl get nodes -l "topology.kubernetes.io/zone=$SINGLE_NODE_SITE,openupstream.io/gvisor=true" -o name) ]]; then
  echo "the node needs the labels topology.kubernetes.io/zone=$SINGLE_NODE_SITE and" \
    "openupstream.io/gvisor=true, and gVisor installed; k3s-single-node.sh sets it up so" >&2
  exit 1
fi
[[ -n $(kubectl get runtimeclass gvisor --ignore-not-found -o name) ]] ||
  { echo "no RuntimeClass gvisor: kubectl apply -f ../gvisor/runtimeclass.yaml" >&2; exit 1; }

record_layout single-node
./operators.sh
./ingress.sh
./garage.sh
./platform.sh
