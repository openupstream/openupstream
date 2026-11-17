#!/usr/bin/env bash
# Deletes everything up.sh created (servers, their volumes, firewall, SSH
# key, local state) and the DNS records that ../dev-cluster/ingress.sh and
# garage.sh created, and the one platform.sh created for the waitlist
# (SIGNUP=closed; read from the cluster, or WAITLIST_DOMAIN).
set -euo pipefail

cd "$(dirname "$0")"
PREFIX=${PREFIX:-oup-dev}
LABEL="openupstream=dev"
# The DNS records first: they point at the servers' addresses. It never
# fails, so a failure there cannot keep the servers running (and billing).
KUBECONFIG=$PWD/.state/kubeconfig ../dev-cluster/dns-delete-all.sh || true
for name in $(hcloud server list --selector "$LABEL" -o noheader -o columns=name); do
  echo "deleting $name"
  hcloud server delete "$name" >/dev/null
done
# Detached with their servers; a volume left behind would bill on.
for name in $(hcloud volume list --selector "$LABEL" -o noheader -o columns=name); do
  echo "deleting volume $name"
  hcloud volume delete "$name" >/dev/null
done
hcloud firewall describe "$PREFIX" >/dev/null 2>&1 && hcloud firewall delete "$PREFIX" >/dev/null
hcloud ssh-key describe "$PREFIX" >/dev/null 2>&1 && hcloud ssh-key delete "$PREFIX" >/dev/null
rm -rf .state
hcloud server list --selector "$LABEL"
hcloud volume list --selector "$LABEL"
