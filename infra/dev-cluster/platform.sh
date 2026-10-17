#!/usr/bin/env bash
# Bootstraps the platform on the dev cluster, after operators.sh:
#
# 1. the control plane's own Database (the platform Project's, PLATFORM in
#    sdk/src/internal.ts), with one reconcile pass from this machine;
# 2. the control plane next to it, which migrates and seeds the platform
#    rows, so from then on the operator owns that Database too;
# 3. the Databases operator, reconciling every 30 s with rows from the
#    control plane.
#
# Images come from GHCR, pinned by digest: by default the ones built for the
# current commit (.github/workflows/images.yml). Override with IMAGE_TAG.
#
# Needs: KUBECONFIG, kubectl, docker (buildx, to resolve digests), node.
set -euo pipefail

cd "$(dirname "$0")"
ROOT=$(git rev-parse --show-toplevel)
IMAGE_TAG=${IMAGE_TAG:-$(git rev-parse HEAD)}
CONFIG=$PWD/database-config.json
PLATFORM_NS=project-00000000-0000-4000-8000-000000000002
PLATFORM_DB=db-00000000-0000-4000-8000-000000000003

digest() { # image name → image@sha256:…
  local ref="ghcr.io/openupstream/$1:$IMAGE_TAG"
  echo "ghcr.io/openupstream/$1@$(docker buildx imagetools inspect "$ref" --format '{{json .Manifest.Digest}}' | tr -d '"')"
}
CONTROL_PLANE_IMAGE=$(digest control-plane)
OPERATORS_IMAGE=$(digest operators)
echo "control plane: $CONTROL_PLANE_IMAGE"
echo "operators:     $OPERATORS_IMAGE"

(cd "$ROOT/operators" && npx tsx scripts/reconcile-databases.ts --platform "$CONFIG" >/dev/null)
kubectl -n "$PLATFORM_NS" wait "cluster/$PLATFORM_DB" --for=condition=Ready --timeout=10m

sed "s#ghcr.io/openupstream/control-plane:main#$CONTROL_PLANE_IMAGE#" "$ROOT/control-plane/deploy/control-plane.yaml" |
  kubectl apply -f - >/dev/null
kubectl -n "$PLATFORM_NS" rollout status deployment/control-plane --timeout=5m

kubectl apply -f "$ROOT/operators/deploy/databases-rbac.yaml" >/dev/null
kubectl -n openupstream-system create configmap databases-operator-config --dry-run=client -o yaml \
  --from-file=database-config.json="$CONFIG" | kubectl apply -f - >/dev/null
sed "s#ghcr.io/openupstream/operators:main#$OPERATORS_IMAGE#" "$ROOT/operators/deploy/databases-operator.yaml" |
  kubectl apply -f - >/dev/null
kubectl -n openupstream-system rollout status deployment/databases-operator --timeout=5m
kubectl -n openupstream-system logs deployment/databases-operator --tail=3
