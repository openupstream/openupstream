#!/usr/bin/env bash
# Installs the platform on a cluster with nodes in three or more Sites, the
# layout of production (ARCHITECTURE.md, "Sites and failure handling";
# decision 112, ADR-0007): labels the compute Sites' and the default Site's
# nodes (label_sites in lib.sh), records the layout, then runs
# operators.sh, ingress.sh, garage.sh, monitoring.sh and platform.sh. With
# ALERT_EMAIL set, monitoring.sh also sends alerts (README).
#
# Every node carries its Site's id as topology.kubernetes.io/zone. The first
# run names the compute Sites, later runs keep them:
#
#   COMPUTE_SITES="home-a home-b" ./install-multi-node.sh
#
# DEFAULT_SITE moves the default Home site, SITE_DESCRIPTIONS sets the
# Sites' descriptions (`id=text;id=text`). Refuses, changing nothing, fewer
# than two compute Sites or three Sites, or a node outside the compute
# Sites without the taint openupstream.io/third-site=true:NoSchedule: then
# Garage's three copies, etcd's quorum and the Databases' standbys have
# nowhere to go. For one node, use install-single-node.sh.
#
# Needs: KUBECONFIG (infra/dev-cluster-hetzner/up.sh makes such a cluster)
# and what the four steps need (README).
set -euo pipefail

cd "$(dirname "$0")"
source ./lib.sh

label_sites multi-node
record_layout multi-node
./operators.sh
./ingress.sh
./garage.sh
./monitoring.sh
./platform.sh
