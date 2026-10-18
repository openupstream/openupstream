#!/usr/bin/env bash
# Deletes everything up.sh and ingress.sh created: DNS records, servers,
# firewall, SSH key, local state.
set -euo pipefail

cd "$(dirname "$0")"
PREFIX=${PREFIX:-oup-dev}
LABEL="openupstream=dev"

# The DNS records first: they point at the servers' addresses.
[[ -f ${BUNNY_API_KEY_FILE:-$HOME/.config/openupstream/bunny-api-key} ]] && ./dns.sh --delete
for name in $(hcloud server list --selector "$LABEL" -o noheader -o columns=name); do
  echo "deleting $name"
  hcloud server delete "$name" >/dev/null
done
hcloud firewall describe "$PREFIX" >/dev/null 2>&1 && hcloud firewall delete "$PREFIX" >/dev/null
hcloud ssh-key describe "$PREFIX" >/dev/null 2>&1 && hcloud ssh-key delete "$PREFIX" >/dev/null
rm -rf .state
hcloud server list --selector "$LABEL"
