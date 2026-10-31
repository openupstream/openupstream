#!/usr/bin/env bash
# Public ingress on the dev cluster, after operators.sh (ARCHITECTURE.md,
# "Ingress and failover"; decisions 69, 72, 73):
#
# 1. cert-manager's DNS-01 webhook for bunny.net, with the API key as the
#    one Secret it may read;
# 2. the Let's Encrypt ClusterIssuers;
# 3. Traefik on both compute nodes, on their ports 80 and 443;
# 4. the platform hostnames in bunny.net DNS (dns.sh).
#
# platform.sh then adds the platform's routes and certificate.
#
# Needs: KUBECONFIG, kubectl, helm, the bunny.net API key in
# ~/.config/openupstream/bunny-api-key.
set -euo pipefail

cd "$(dirname "$0")"
ROOT=$(git rev-parse --show-toplevel)
KEY_FILE=${BUNNY_API_KEY_FILE:-$HOME/.config/openupstream/bunny-api-key}

kubectl -n cert-manager create secret generic bunny-api --dry-run=client -o yaml \
  --from-literal=api-key="$(tr -d ' \n\r' <"$KEY_FILE")" | kubectl apply -f - >/dev/null
helm upgrade --install bunny-webhook oci://ghcr.io/aardbol/charts/cert-manager-webhook-bunny --version 1.4.2 \
  -n cert-manager -f "$ROOT/infra/ingress/webhook-bunny-values.yaml" --wait --timeout 5m >/dev/null
kubectl apply -f "$ROOT/infra/ingress/cluster-issuers.yaml" >/dev/null

# The namespace traefik is admitted by every Project's NetworkPolicy
# (INGRESS_FROM_NAMESPACES in operators/src/kubernetes.ts).
helm upgrade --install traefik oci://ghcr.io/traefik/helm/traefik --version 42.0.0 \
  -n traefik --create-namespace -f "$ROOT/infra/ingress/traefik-values.yaml" --wait --timeout 5m >/dev/null
kubectl -n traefik get pods -o wide --no-headers | awk '{print $1, $3, $7}'

./dns.sh
