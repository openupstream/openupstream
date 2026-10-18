#!/usr/bin/env bash
# Points the platform's hostnames at both compute nodes, as bunny.net record
# sets with HTTP health checks: bunny.net drops the record of a node whose
# port 80 stops answering (ARCHITECTURE.md, decisions 32 and 34).
#
#   ./dns.sh           create or replace the A records
#   ./dns.sh --delete  remove them (down.sh does)
#
# Needs: the bunny.net API key in ~/.config/openupstream/bunny-api-key,
# hcloud, curl, jq. The zone is DEV_ZONE (default dev.openupstream.com),
# delegated to bunny.net (docs/self-hosting.md, section 5).
set -euo pipefail

cd "$(dirname "$0")"
PREFIX=${PREFIX:-oup-dev}
DEV_ZONE=${DEV_ZONE:-dev.openupstream.com}
NAMES=("" "api")   # the zone apex: madAuth (and later the dashboard); api: the API
KEY=$(tr -d ' \n\r' <"${BUNNY_API_KEY_FILE:-$HOME/.config/openupstream/bunny-api-key}")
api() { curl -fsS -H "AccessKey: $KEY" -H 'content-type: application/json' "$@"; }

ZONE_ID=$(api "https://api.bunny.net/dnszone?search=$DEV_ZONE" | jq -r --arg z "$DEV_ZONE" '.Items[] | select(.Domain == $z) | .Id')
[[ -n $ZONE_ID ]] || { echo "no bunny.net zone $DEV_ZONE" >&2; exit 1; }

# Type 0 is A. Only our names, so records someone added by hand stay.
existing=$(api "https://api.bunny.net/dnszone/$ZONE_ID" | jq -c '.Records[] | select(.Type == 0) | {Id, Name}')
for name in "${NAMES[@]}"; do
  for id in $(jq -r --arg n "$name" 'select(.Name == $n) | .Id' <<<"$existing"); do
    api -X DELETE "https://api.bunny.net/dnszone/$ZONE_ID/records/$id" >/dev/null
  done
done
[[ ${1:-} == --delete ]] && { echo "removed the A records in $DEV_ZONE"; exit 0; }

for site in hetzner-fsn1 ovh-lim; do
  ip=$(hcloud server ip "$PREFIX-$site")
  for name in "${NAMES[@]}"; do
    # MonitorType 2: HTTP on port 80 every 30 s from three regions.
    api -X PUT "https://api.bunny.net/dnszone/$ZONE_ID/records" \
      -d "$(jq -n --arg n "$name" --arg ip "$ip" '{Type: 0, Name: $n, Value: $ip, Ttl: 60, MonitorType: 2}')" >/dev/null
    echo "${name:+$name.}$DEV_ZONE A $ip ($site)"
  done
done
