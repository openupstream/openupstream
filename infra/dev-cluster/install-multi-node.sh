#!/usr/bin/env bash
# Installs the platform on a cluster with nodes in three or more Sites, the
# layout of production (ARCHITECTURE.md, "Sites and failure handling";
# decision 112, ADR-0007): checks the nodes' Site labels (check_sites in
# lib.sh), records the layout, then runs operators.sh, ingress.sh,
# garage.sh, monitoring.sh and platform.sh. With ALERT_EMAIL set,
# monitoring.sh also sends alerts (README).
#
# The node setup labels the nodes when they join (README, "Sites"); this
# script never changes a label. It refuses, before recording anything, a
# node without a Site, fewer than two compute Sites or three Sites, a
# default Site that is not exactly one compute Site, or a taint
# openupstream.io/quorum-only=true:NoSchedule missing outside the compute
# Sites or present inside: then Garage's three copies, etcd's quorum and
# the Databases' standbys have nowhere to go. Each refusal names the
# kubectl command that fixes it. For one node, use install-single-node.sh.
#
# Needs: KUBECONFIG (infra/dev-cluster-hetzner/up.sh makes such a cluster)
# and what the four steps need (README).
set -euo pipefail

cd "$(dirname "$0")"
source ./lib.sh

check_sites multi-node
record_layout multi-node
./operators.sh
./ingress.sh
./garage.sh
./monitoring.sh
./platform.sh
