#!/usr/bin/env bash
# Deletes everything up.sh created (servers, their volumes, firewall, SSH
# key, local state) and the DNS records that ../dev-cluster/ingress.sh and
# garage.sh created.
set -euo pipefail

cd "$(dirname "$0")"
PREFIX=${PREFIX:-oup-dev}
LABEL="openupstream=dev"
DNS=../dev-cluster/dns.sh

# The DNS records first: they point at the servers' addresses.
# A failure here must not keep the servers running (and billing).
if [[ -f ${BUNNY_API_KEY_FILE:-$HOME/.config/openupstream/bunny-api-key} ]]; then
  DNS_DOMAIN=${PLATFORM_DOMAIN:-dev.openupstream.com} "$DNS" --delete ||
    echo "could not remove the DNS records; remove them in bunny.net" >&2
  DNS_DOMAIN=${CUSTOMER_DOMAIN:-dev.openupstream.app} DNS_NAMES='* *.s3' "$DNS" --delete ||
    echo "could not remove the S3 records; remove them in bunny.net" >&2
fi
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
