#!/usr/bin/env bash
# Installs the platform on a cluster with one node per Site, the layout of
# production (ARCHITECTURE.md, "Sites and failure handling"; decision 112):
# records the layout, then runs operators.sh, ingress.sh, garage.sh,
# monitoring.sh and platform.sh. With ALERT_EMAIL set, monitoring.sh also
# sends alerts (README).
#
# Refuses a cluster without a node in each of the three Sites
# (topology.kubernetes.io/zone hetzner-fsn1, ovh-lim, netcup-nbg): with
# fewer nodes Garage's three copies, etcd's quorum and the Databases'
# standbys have nowhere to go. For one node, use install-single-node.sh.
#
# Needs: KUBECONFIG (infra/dev-cluster-hetzner/up.sh makes such a cluster)
# and what the four steps need (README).
set -euo pipefail

cd "$(dirname "$0")"
source ./lib.sh

missing=()
for site in "${SITES[@]}"; do
  [[ -n $(kubectl get nodes -l "topology.kubernetes.io/zone=$site" -o name) ]] || missing+=("$site")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "no node in ${missing[*]}: install-multi-node.sh needs a node in each of ${SITES[*]}," \
    "labelled topology.kubernetes.io/zone; for one node use install-single-node.sh" >&2
  exit 1
fi

record_layout multi-node
./operators.sh
./ingress.sh
./garage.sh
./monitoring.sh
./platform.sh
