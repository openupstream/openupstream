#!/usr/bin/env bash
# Object storage on the dev cluster, after ingress.sh and before platform.sh
# (ARCHITECTURE.md, "Object storage"; decisions 82 and 83):
#
# 1. the Secret garage (RPC secret and admin token), generated once and kept
#    in the cluster only; the admin token also goes to the platform
#    Project's namespace as garage-admin, for the control plane;
# 2. Garage, one node per Site (infra/garage/garage.yaml);
# 3. the layout: each node's zone is its Site, with GARAGE_CAPACITY each,
#    applied once;
# 4. the public S3 endpoint https://<bucket>.s3.$CUSTOMER_DOMAIN: the
#    wildcard certificate, the route, and `*.s3` in bunny.net DNS (dns.sh).
#
# Needs: KUBECONFIG, kubectl, openssl, the bunny.net API key, and
# CUSTOMER_DOMAIN's zone delegated to bunny.net (docs/self-hosting.md,
# section 5).
set -euo pipefail

cd "$(dirname "$0")"
ROOT=$(git rev-parse --show-toplevel)
PLATFORM_NS=project-00000000-0000-4000-8000-000000000002
# The customer domain (decision 68): openupstream.app in production, its
# delegated dev zone here.
CUSTOMER_DOMAIN=${CUSTOMER_DOMAIN:-dev.openupstream.app}
CLUSTER_ISSUER=${CLUSTER_ISSUER:-letsencrypt-staging}
GARAGE_DATA_SIZE=${GARAGE_DATA_SIZE:-20Gi}
# What each node offers to the layout; at most its volume.
GARAGE_CAPACITY=${GARAGE_CAPACITY:-20G}

if ! kubectl -n garage get secret garage >/dev/null 2>&1; then
  kubectl create namespace garage --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  # Generated here and piped straight into the Secret, never shown.
  printf 'GARAGE_RPC_SECRET=%s\nGARAGE_ADMIN_TOKEN=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" |
    kubectl -n garage create secret generic garage --from-env-file=/dev/stdin
fi
kubectl create namespace "$PLATFORM_NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n garage get secret garage -o jsonpath='{.data.GARAGE_ADMIN_TOKEN}' | base64 -d |
  kubectl -n "$PLATFORM_NS" create secret generic garage-admin --dry-run=client -o yaml \
    --from-file=GARAGE_ADMIN_TOKEN=/dev/stdin | kubectl apply -f - >/dev/null

sed -e "s#CUSTOMER_DOMAIN#$CUSTOMER_DOMAIN#g" -e "s#GARAGE_DATA_SIZE#$GARAGE_DATA_SIZE#g" "$ROOT/infra/garage/garage.yaml" |
  kubectl apply -f - >/dev/null
# Not ready until the layout is applied (its health check needs a quorum),
# so wait for the pods to run, not for the rollout.
for pod in garage-0 garage-1 garage-2; do
  kubectl -n garage wait pod/"$pod" --for=create --timeout=2m >/dev/null
done
kubectl -n garage wait pod -l app.kubernetes.io/name=garage --for=jsonpath='{.status.phase}'=Running --timeout=5m >/dev/null

# The CLI logs its connection to stderr; its exit code still counts.
garage() { kubectl -n garage exec garage-0 -- /garage "$@" 2>/dev/null; }

# The nodes find each other through their GarageNode objects; wait for all three.
for _ in $(seq 60); do
  [[ $(kubectl -n garage get garagenodes --no-headers 2>/dev/null | wc -l) -ge 3 ]] && break
  sleep 5
done

# A node's zone is its pod's Site.
if [[ $(garage layout show | grep -c 'Current cluster layout version: 0') -eq 1 ]]; then
  for pod in garage-0 garage-1 garage-2; do
    node=$(kubectl -n garage get pod "$pod" -o jsonpath='{.spec.nodeName}')
    site=$(kubectl get node "$node" -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}')
    id=$(kubectl -n garage exec "$pod" -- /garage node id -q 2>/dev/null | cut -d@ -f1)
    garage layout assign -z "$site" -c "$GARAGE_CAPACITY" "$id" >/dev/null
    echo "garage: $pod ($site) ${id:0:16}"
  done
  garage layout apply --version 1 >/dev/null
fi
kubectl -n garage rollout status statefulset/garage --timeout=5m
garage status

escaped=${CUSTOMER_DOMAIN//./\\\\.}
sed -e "s#CUSTOMER_DOMAIN_REGEX#$escaped#g" -e "s#CUSTOMER_DOMAIN#$CUSTOMER_DOMAIN#g" -e "s#CLUSTER_ISSUER#$CLUSTER_ISSUER#g" \
  "$ROOT/infra/garage/s3-route.yaml" | kubectl apply -f - >/dev/null
DEV_ZONE=$CUSTOMER_DOMAIN DNS_NAMES='*.s3' ./dns.sh
kubectl -n garage wait certificate/s3 --for=condition=Ready --timeout=10m
