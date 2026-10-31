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
# delegated to bunny.net (docs/self-hosting.md, section 5); the names in it
# are DNS_NAMES, `@` for the zone apex (default `@ api`: madAuth, and later
# the dashboard, at the apex; the API at api). garage.sh points `*` and
# `*.s3` in the customer zone at the nodes the same way.
set -euo pipefail

cd "$(dirname "$0")"
PREFIX=${PREFIX:-oup-dev}
DEV_ZONE=${DEV_ZONE:-dev.openupstream.com}
read -r -a NAMES <<<"${DNS_NAMES:-@ api}"
NAMES=("${NAMES[@]/#@/}")
KEY=$(tr -d ' \n\r' <"${BUNNY_API_KEY_FILE:-$HOME/.config/openupstream/bunny-api-key}")
api() { curl -fsS -H "AccessKey: $KEY" -H 'content-type: application/json' "$@"; }

ZONE_ID=$(api "https://api.bunny.net/dnszone?search=$DEV_ZONE" | jq -r --arg z "$DEV_ZONE" '.Items[] | select(.Domain == $z) | .Id')
[[ -n $ZONE_ID ]] || { echo "no bunny.net zone $DEV_ZONE" >&2; exit 1; }

# Type 0 is A. Only our names, so records someone added by hand stay.
records() { api "https://api.bunny.net/dnszone/$ZONE_ID" | jq -c --argjson names "$(printf '%s\n' "${NAMES[@]}" | jq -R . | jq -s .)" \
  '.Records[] | select(.Type == 0 and (.Name as $n | $names | index($n))) | {Id, Name, Value}'; }
delete_records() { # records (JSON lines) to delete
  for id in $(jq -r '.Id' <<<"$1"); do
    api -X DELETE "https://api.bunny.net/dnszone/$ZONE_ID/records/$id" >/dev/null
  done
}

existing=$(records)
if [[ ${1:-} == --delete ]]; then
  delete_records "$existing"
  echo "removed the A records in $DEV_ZONE"
  exit 0
fi

# New records first, then the stale ones, so the names always resolve.
IPS=()
for site in hetzner-fsn1 ovh-lim; do
  ip=$(hcloud server ip "$PREFIX-$site")
  IPS+=("$ip")
  for name in "${NAMES[@]}"; do
    if jq -e --arg n "$name" --arg ip "$ip" 'select(.Name == $n and .Value == $ip)' <<<"$existing" >/dev/null; then
      echo "${name:+$name.}$DEV_ZONE A $ip ($site, kept)"
      continue
    fi
    # MonitorType 2: HTTP on port 80 every 30 s from three regions.
    api -X PUT "https://api.bunny.net/dnszone/$ZONE_ID/records" \
      -d "$(jq -n --arg n "$name" --arg ip "$ip" '{Type: 0, Name: $n, Value: $ip, Ttl: 60, MonitorType: 2}')" >/dev/null
    echo "${name:+$name.}$DEV_ZONE A $ip ($site)"
  done
done
delete_records "$(jq -c --argjson ips "$(printf '%s\n' "${IPS[@]}" | jq -R . | jq -s .)" 'select(.Value as $v | $ips | index($v) | not)' <<<"$existing")"
