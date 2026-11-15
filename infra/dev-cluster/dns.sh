#!/usr/bin/env bash
# Points hostnames at the compute nodes, as bunny.net A records
# (ARCHITECTURE.md, decisions 32, 34 and 112). The addresses are the compute
# nodes' own, as Kubernetes reports them (ExternalIP, else InternalIP; IPv4),
# so this works for any cluster: public addresses for the Hetzner dev
# cluster, the node's address in the home network for a single node.
#
#   ./dns.sh           create or replace the A records
#   ./dns.sh --delete  remove them (infra/dev-cluster-hetzner/down.sh does)
#
# DNS_DOMAIN is the domain the names belong to: a bunny.net zone or a name
# inside one (e.g. home.dev.openupstream.com in the zone
# dev.openupstream.com). DNS_NAMES are relative to it, `@` for DNS_DOMAIN
# itself (default `@`: madAuth and the API, for ingress.sh; garage.sh
# passes `* *.s3` for the customer domain).
#
# In multi-node each record gets an HTTP health check (port 80 every 30 s
# from three regions), so bunny.net drops a dark Site's record. A single
# node has no other record to fall back to, and a private address cannot be
# checked from outside, so its record has none.
#
# Needs: the bunny.net API key in ~/.config/openupstream/bunny-api-key,
# curl, jq, and for creating records KUBECONFIG and kubectl.
set -euo pipefail

cd "$(dirname "$0")"
source ./lib.sh
DNS_DOMAIN=${DNS_DOMAIN:?set DNS_DOMAIN, the domain the names belong to}
read -r -a NAMES <<<"${DNS_NAMES:-@}"
# Clusters installed before the API moved under /api (decision 117) also
# have an `api` record; --delete takes it along.
if [[ ${1:-} == --delete && -z ${DNS_NAMES:-} ]]; then
  NAMES+=(api)
fi
KEY=$(tr -d ' \n\r' <"${BUNNY_API_KEY_FILE:-$HOME/.config/openupstream/bunny-api-key}")
api() { curl -fsS -H "AccessKey: $KEY" -H 'content-type: application/json' "$@"; }

# The zone is DNS_DOMAIN or the closest domain above it that is a zone.
zone_id() { # domain → zone id, or nothing
  api "https://api.bunny.net/dnszone?search=$1" | jq -r --arg z "$1" '.Items[] | select(.Domain == $z) | .Id'
}
ZONE=$DNS_DOMAIN
ZONE_ID=$(zone_id "$ZONE")
while [[ -z $ZONE_ID && $ZONE == *.*.* ]]; do
  ZONE=${ZONE#*.}
  ZONE_ID=$(zone_id "$ZONE")
done
[[ -n $ZONE_ID ]] || { echo "no bunny.net zone for $DNS_DOMAIN" >&2; exit 1; }

# The names inside the zone: DNS_DOMAIN's own part in front of the zone,
# after each name. `@` in the zone itself is the empty name.
PREFIX=${DNS_DOMAIN%"$ZONE"}
PREFIX=${PREFIX%.}
RECORD_NAMES=()
for name in "${NAMES[@]}"; do
  name=${name/#@/}
  RECORD_NAMES+=("$name${name:+${PREFIX:+.}}$PREFIX")
done

# Type 0 is A. Only our names, so records someone added by hand stay.
records() { api "https://api.bunny.net/dnszone/$ZONE_ID" | jq -c --argjson names "$(printf '%s\n' "${RECORD_NAMES[@]}" | jq -R . | jq -s .)" \
  '.Records[] | select(.Type == 0 and (.Name as $n | $names | index($n))) | {Id, Name, Value}'; }
delete_records() { # records (JSON lines) to delete
  for id in $(jq -r '.Id' <<<"$1"); do
    api -X DELETE "https://api.bunny.net/dnszone/$ZONE_ID/records/$id" >/dev/null
  done
}

existing=$(records)
if [[ ${1:-} == --delete ]]; then
  delete_records "$existing"
  echo "removed the A records for $DNS_DOMAIN in $ZONE"
  exit 0
fi

LAYOUT=$(cluster_layout)
MONITOR=2
[[ $LAYOUT == single-node ]] && MONITOR=0

# Each compute node's Site and IPv4 address, ExternalIP before InternalIP.
nodes=$(kubectl get nodes -l "topology.kubernetes.io/zone in ($(IFS=,; echo "${COMPUTE_SITES[*]}"))" -o json | jq -r '.items[] |
  [.metadata.labels["topology.kubernetes.io/zone"],
   ([.status.addresses[] | select(.type == "ExternalIP" and (.address | test("^[0-9.]+$"))) | .address] +
    [.status.addresses[] | select(.type == "InternalIP" and (.address | test("^[0-9.]+$"))) | .address])[0] // empty] |
  select(length == 2) | join(" ")')
[[ -n $nodes ]] || { echo "no compute node with an IPv4 address" >&2; exit 1; }

# New records first, then the stale ones, so the names always resolve.
IPS=()
while read -r site ip; do
  IPS+=("$ip")
  for name in "${RECORD_NAMES[@]}"; do
    fqdn="$name${name:+.}$ZONE"
    if jq -e --arg n "$name" --arg ip "$ip" 'select(.Name == $n and .Value == $ip)' <<<"$existing" >/dev/null; then
      echo "$fqdn A $ip ($site, kept)"
      continue
    fi
    api -X PUT "https://api.bunny.net/dnszone/$ZONE_ID/records" \
      -d "$(jq -n --arg n "$name" --arg ip "$ip" --argjson m "$MONITOR" '{Type: 0, Name: $n, Value: $ip, Ttl: 60, MonitorType: $m}')" >/dev/null
    echo "$fqdn A $ip ($site)"
  done
done <<<"$nodes"
delete_records "$(jq -c --argjson ips "$(printf '%s\n' "${IPS[@]}" | jq -R . | jq -s .)" 'select(.Value as $v | $ips | index($v) | not)' <<<"$existing")"
