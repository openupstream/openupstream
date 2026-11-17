#!/usr/bin/env bash
# Deletes every DNS record the install created: those of ingress.sh
# (PLATFORM_DOMAIN) and garage.sh (CUSTOMER_DOMAIN), and the one
# platform.sh created for the waitlist (SIGNUP=closed; read from the
# cluster while it still answers, or WAITLIST_DOMAIN). The down.sh of
# ../dev-cluster-hetzner and ../dev-cluster-incus run it before deleting
# the VMs; it never fails, so the VMs go anyway.
#
#   KUBECONFIG=.state/kubeconfig ../dev-cluster/dns-delete-all.sh
#
# Does nothing without the bunny.net API key.
set -uo pipefail

cd "$(dirname "$0")"
[[ -f ${BUNNY_API_KEY_FILE:-$HOME/.config/openupstream/bunny-api-key} ]] || exit 0

# The host in the control plane's WAITLIST_URL, or nothing.
waitlist_domain() {
  [[ -n ${KUBECONFIG:-} && -f $KUBECONFIG ]] || return 0
  kubectl --request-timeout=10s -n project-00000000-0000-4000-8000-000000000002 \
    get configmap control-plane-config --ignore-not-found -o jsonpath='{.data.WAITLIST_URL}' 2>/dev/null |
    sed -e 's#^https\{0,1\}://##' -e 's#/.*$##' || true
}

DNS_DOMAIN=${PLATFORM_DOMAIN:-dev.openupstream.com} ./dns.sh --delete ||
  echo "could not remove the DNS records; remove them in bunny.net" >&2
DNS_DOMAIN=${CUSTOMER_DOMAIN:-dev.openupstream.app} DNS_NAMES='* *.s3' ./dns.sh --delete ||
  echo "could not remove the S3 records; remove them in bunny.net" >&2
# DNS_NAMES keeps dns.sh from taking a record `api` of that domain along.
WAITLIST_DOMAIN=${WAITLIST_DOMAIN:-$(waitlist_domain)}
if [[ -n $WAITLIST_DOMAIN ]]; then
  DNS_DOMAIN=$WAITLIST_DOMAIN DNS_NAMES=@ ./dns.sh --delete ||
    echo "could not remove the waitlist's DNS record; remove it in bunny.net" >&2
fi
exit 0
