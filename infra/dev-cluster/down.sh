#!/usr/bin/env bash
# Deletes everything up.sh created: servers, firewall, SSH key, local state.
set -euo pipefail

cd "$(dirname "$0")"
PREFIX=${PREFIX:-oup-dev}
LABEL="openupstream=dev"

for name in $(hcloud server list --selector "$LABEL" -o noheader -o columns=name); do
  echo "deleting $name"
  hcloud server delete "$name" >/dev/null
done
hcloud firewall describe "$PREFIX" >/dev/null 2>&1 && hcloud firewall delete "$PREFIX" >/dev/null
hcloud ssh-key describe "$PREFIX" >/dev/null 2>&1 && hcloud ssh-key delete "$PREFIX" >/dev/null
rm -rf .state
hcloud server list --selector "$LABEL"
