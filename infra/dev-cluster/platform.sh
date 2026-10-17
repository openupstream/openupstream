#!/usr/bin/env bash
# Bootstraps the platform on the dev cluster, after operators.sh:
#
# 1. the platform Project's Databases (PLATFORM in sdk/src/internal.ts):
#    the control plane's and madAuth's, with one reconcile pass from this
#    machine;
# 2. madAuth with its sidecar, its signing key and webhook secret generated
#    once; on the dev cluster its e-mails go to the sidecar's log (MAIL=log)
#    and its public URL is http://localhost:8787 (a port-forward);
# 3. the control plane, which migrates and seeds the platform rows, so from
#    then on the operator owns those Databases too;
# 4. the Databases operator, reconciling every 30 s with rows from the
#    control plane.
#
# Images come from GHCR, pinned by digest: by default the ones built for the
# current commit (.github/workflows/images.yml). Override with IMAGE_TAG.
#
# Needs: KUBECONFIG, kubectl, curl, jq, node.
set -euo pipefail

cd "$(dirname "$0")"
ROOT=$(git rev-parse --show-toplevel)
IMAGE_TAG=${IMAGE_TAG:-$(git rev-parse HEAD)}
CONFIG=$PWD/database-config.json
PLATFORM_NS=project-00000000-0000-4000-8000-000000000002
PLATFORM_DB=db-00000000-0000-4000-8000-000000000003
AUTH_DB=db-00000000-0000-4000-8000-000000000004
# madAuth's public URL: the issuer of its tokens, and the only app origin.
# On the dev cluster: kubectl -n $PLATFORM_NS port-forward svc/madauth 8787
MADAUTH_ISSUER=${MADAUTH_ISSUER:-http://localhost:8787}

# Anonymous, like the cluster's pull: fails while a package is not public.
digest() { # image name → image@sha256:…
  local repo="openupstream/$1" token digest
  token=$(curl -fsS "https://ghcr.io/token?scope=repository:$repo:pull" | jq -r .token) ||
    { echo "ghcr.io/$repo is not public" >&2; exit 1; }
  digest=$(curl -fsSI -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json" \
    "https://ghcr.io/v2/$repo/manifests/$IMAGE_TAG" | tr -d '\r' | awk -F': ' 'tolower($1) == "docker-content-digest" {print $2}')
  [[ -n $digest ]] || { echo "no $repo:$IMAGE_TAG on GHCR, or it is not public" >&2; exit 1; }
  echo "ghcr.io/$repo@$digest"
}
CONTROL_PLANE_IMAGE=$(digest control-plane)
OPERATORS_IMAGE=$(digest operators)
echo "control plane: $CONTROL_PLANE_IMAGE"
echo "operators:     $OPERATORS_IMAGE"

(cd "$ROOT/operators" && npx tsx scripts/reconcile-databases.ts --platform "$CONFIG" >/dev/null)
kubectl -n "$PLATFORM_NS" wait "cluster/$PLATFORM_DB" "cluster/$AUTH_DB" --for=condition=Ready --timeout=10m

# madAuth's keys: generated once, kept in the cluster only. The signing key
# is a private ES256 JWK, as `madauth generate-key` makes it.
if ! kubectl -n "$PLATFORM_NS" get secret madauth >/dev/null 2>&1; then
  (cd "$ROOT/control-plane" && node --input-type=module -e "
    import { calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
    import { randomBytes } from 'node:crypto';
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const jwk = await exportJWK(privateKey);
    const key = { ...jwk, alg: 'ES256', kid: await calculateJwkThumbprint(jwk) };
    console.log(JSON.stringify({ apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
      metadata: { name: 'madauth', namespace: '$PLATFORM_NS' },
      stringData: { MADAUTH_SIGNING_KEY: JSON.stringify(key), WEBHOOK_SECRET: 'whsec_' + randomBytes(32).toString('base64') } }));
  ") | kubectl apply -f - >/dev/null
fi
kubectl -n "$PLATFORM_NS" create configmap madauth-config --dry-run=client -o yaml \
  --from-literal=MADAUTH_ISSUER="$MADAUTH_ISSUER" \
  --from-literal=ALLOWED_ORIGINS="$MADAUTH_ISSUER" \
  --from-literal=WEBHOOK_EVENTS=email.send_verification,email.send_password_reset,email.send_already_registered,email.send_password_reset_no_password \
  --from-literal=MAIL=log | kubectl apply -f - >/dev/null
sed "s#ghcr.io/openupstream/control-plane:main#$CONTROL_PLANE_IMAGE#" "$ROOT/infra/madauth/madauth.yaml" |
  kubectl apply -f - >/dev/null
kubectl -n "$PLATFORM_NS" rollout status deployment/madauth --timeout=5m

kubectl -n "$PLATFORM_NS" create configmap control-plane-config --dry-run=client -o yaml \
  --from-literal=AUTH_ISSUER="$MADAUTH_ISSUER" \
  --from-literal=MADAUTH_URL="http://madauth.$PLATFORM_NS.svc:8787" \
  --from-literal=BACKUP_BUCKET="$(jq -r .backup.bucket "$CONFIG")" \
  --from-literal=BACKUP_RETENTION="$(jq -r .backup.retention "$CONFIG")" | kubectl apply -f - >/dev/null
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
