#!/usr/bin/env bash
# Bootstraps the platform on the dev cluster, after operators.sh, ingress.sh
# and garage.sh:
#
# 1. the platform Project's Databases (PLATFORM in sdk/src/internal.ts):
#    the control plane's and madAuth's, with one reconcile pass from this
#    machine;
# 2. madAuth with its sidecar, its signing key and webhook secret generated
#    once, its e-mails sent through Amazon SES with the AWS CLI profile
#    openupstream-ses (MAIL=log writes them to the sidecar's log instead);
# 3. the control plane, which migrates and seeds the platform rows, so from
#    then on the operator owns those Databases too; it manages Buckets in
#    Garage with the admin token garage.sh left it, and encrypts Secrets
#    with a key-encryption key generated once (secrets-kek);
# 4. the public hostnames (after ingress.sh): madAuth at
#    https://$PLATFORM_DOMAIN/auth, the API at https://api.$PLATFORM_DOMAIN,
#    with a certificate from CLUSTER_ISSUER;
# 5. the Databases operator, reconciling every 30 s with rows from the
#    control plane;
# 6. the Routes operator, turning the routing table into Traefik objects
#    every 30 s;
# 7. the Services operator, running every Service as a Deployment under
#    gVisor every 30 s.
#
# Images come from GHCR, pinned by digest: by default the ones built for the
# current commit (.github/workflows/images.yml). Override with IMAGE_TAG.
#
# Needs: KUBECONFIG, kubectl, curl, jq, node, aws (for MAIL=ses).
set -euo pipefail

cd "$(dirname "$0")"
ROOT=$(git rev-parse --show-toplevel)
IMAGE_TAG=${IMAGE_TAG:-$(git rev-parse HEAD)}
CONFIG=$PWD/database-config.json
PLATFORM_NS=project-00000000-0000-4000-8000-000000000002
PLATFORM_DB=db-00000000-0000-4000-8000-000000000003
AUTH_DB=db-00000000-0000-4000-8000-000000000004
# Our hostnames (ARCHITECTURE.md, decision 67): openupstream.com in
# production, the delegated dev zone here.
PLATFORM_DOMAIN=${PLATFORM_DOMAIN:-dev.openupstream.com}
# The customer domain (decision 68), as garage.sh set it up.
CUSTOMER_DOMAIN=${CUSTOMER_DOMAIN:-dev.openupstream.app}
CLUSTER_ISSUER=${CLUSTER_ISSUER:-letsencrypt-staging}
# madAuth's public URL: the issuer of its tokens, and the only app origin.
MADAUTH_ISSUER=https://$PLATFORM_DOMAIN
MAIL=${MAIL:-ses}
MAIL_FROM=${MAIL_FROM:-no-reply@openupstream.com}
SES_PROFILE=${SES_PROFILE:-openupstream-ses}
# Without a billing service every Account may create Resources. With one,
# e.g. NEW_ACCOUNT_HOLDS=payment-method and BILLING_CALLERS set to its
# ServiceAccount (ARCHITECTURE.md, decision 78).
NEW_ACCOUNT_HOLDS=${NEW_ACCOUNT_HOLDS:-}
BILLING_CALLERS=${BILLING_CALLERS:-}
# INITIAL_ADMIN_EMAIL makes that user madAuth's first admin once they sign
# in; an admin registers the CLI (infra/madauth/register-cli.sh), whose
# client ID then goes into CLI_CLIENT_ID for `oup login` (decision 87).
INITIAL_ADMIN_EMAIL=${INITIAL_ADMIN_EMAIL:-}
CLI_CLIENT_ID=${CLI_CLIENT_ID:-}

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
  --from-literal=MAIL="$MAIL" \
  --from-literal=MAIL_FROM="$MAIL_FROM" \
  --from-literal=SES_REGION="${SES_REGION:-eu-central-1}" \
  ${INITIAL_ADMIN_EMAIL:+--from-literal=INITIAL_ADMIN_EMAIL="$INITIAL_ADMIN_EMAIL"} | kubectl apply -f - >/dev/null
if [[ $MAIL == ses ]]; then
  # The send-only key (docs/self-hosting.md, section 6), straight from the
  # profile into the Secret. Read first: set -e does not see a failure
  # inside $(…) in an argument.
  SES_KEY_ID=$(aws configure get aws_access_key_id --profile "$SES_PROFILE")
  SES_SECRET=$(aws configure get aws_secret_access_key --profile "$SES_PROFILE")
  kubectl -n "$PLATFORM_NS" create secret generic madauth-ses --dry-run=client -o yaml \
    --from-literal=AWS_ACCESS_KEY_ID="$SES_KEY_ID" --from-literal=AWS_SECRET_ACCESS_KEY="$SES_SECRET" |
    kubectl apply -f - >/dev/null
  unset SES_KEY_ID SES_SECRET
fi
# Pods read their ConfigMap once, at start: a hash of it in the pod template
# rolls them out when a run of this script changes it (e.g. CLI_CLIENT_ID),
# and only then.
config_rollout() { # deployment, configmap
  local hash
  hash=$(kubectl -n "$PLATFORM_NS" get configmap "$2" -o jsonpath='{.data}' | shasum | cut -c1-16)
  kubectl -n "$PLATFORM_NS" patch deployment "$1" >/dev/null \
    -p "{\"spec\": {\"template\": {\"metadata\": {\"annotations\": {\"openupstream.io/config-hash\": \"$hash\"}}}}}"
}

sed "s#ghcr.io/openupstream/control-plane:main#$CONTROL_PLANE_IMAGE#" "$ROOT/infra/madauth/madauth.yaml" |
  kubectl apply -f - >/dev/null
config_rollout madauth madauth-config
kubectl -n "$PLATFORM_NS" rollout status deployment/madauth --timeout=5m

# The key-encryption key for Secrets (ARCHITECTURE.md, "Secrets"): created
# once and never replaced, since every Project's data key is wrapped by it.
if ! kubectl -n "$PLATFORM_NS" get secret secrets-kek >/dev/null 2>&1; then
  kubectl -n "$PLATFORM_NS" create secret generic secrets-kek --dry-run=client -o yaml \
    --from-literal=SECRETS_KEK_ID="kek-$(date -u +%Y%m%d)" \
    --from-literal=SECRETS_KEK="$(openssl rand -base64 32)" | kubectl apply -f - >/dev/null
fi

kubectl -n "$PLATFORM_NS" create configmap control-plane-config --dry-run=client -o yaml \
  --from-literal=AUTH_ISSUER="$MADAUTH_ISSUER" \
  --from-literal=MADAUTH_URL="http://madauth.$PLATFORM_NS.svc:8787" \
  --from-literal=BACKUP_BUCKET="$(jq -r .backup.bucket "$CONFIG")" \
  --from-literal=BACKUP_RETENTION="$(jq -r .backup.retention "$CONFIG")" \
  --from-literal=NEW_ACCOUNT_HOLDS="$NEW_ACCOUNT_HOLDS" \
  --from-literal=BILLING_CALLERS="$BILLING_CALLERS" \
  --from-literal=GARAGE_ADMIN_URL=http://garage.garage.svc:3903 \
  --from-literal=GARAGE_S3_URL=http://garage.garage.svc:3900 \
  --from-literal=CUSTOMER_DOMAIN="$CUSTOMER_DOMAIN" \
  --from-literal=PLATFORM_DOMAIN="$PLATFORM_DOMAIN" \
  --from-literal=CLI_CLIENT_ID="${CLI_CLIENT_ID:-}" | kubectl apply -f - >/dev/null
sed "s#ghcr.io/openupstream/control-plane:main#$CONTROL_PLANE_IMAGE#" "$ROOT/control-plane/deploy/control-plane.yaml" |
  kubectl apply -f - >/dev/null
config_rollout control-plane control-plane-config
kubectl -n "$PLATFORM_NS" rollout status deployment/control-plane --timeout=5m

sed -e "s#PLATFORM_DOMAIN#$PLATFORM_DOMAIN#g" -e "s#CLUSTER_ISSUER#$CLUSTER_ISSUER#g" "$ROOT/infra/ingress/platform-routes.yaml" |
  kubectl apply -f - >/dev/null
kubectl -n "$PLATFORM_NS" wait certificate/platform --for=condition=Ready --timeout=10m

kubectl apply -f "$ROOT/operators/deploy/databases-rbac.yaml" >/dev/null
kubectl -n openupstream-system create configmap databases-operator-config --dry-run=client -o yaml \
  --from-file=database-config.json="$CONFIG" | kubectl apply -f - >/dev/null
sed "s#ghcr.io/openupstream/operators:main#$OPERATORS_IMAGE#" "$ROOT/operators/deploy/databases-operator.yaml" |
  kubectl apply -f - >/dev/null
kubectl -n openupstream-system rollout status deployment/databases-operator --timeout=5m
kubectl -n openupstream-system logs deployment/databases-operator --tail=3

kubectl apply -f "$ROOT/operators/deploy/routes-rbac.yaml" >/dev/null
sed -e "s#ghcr.io/openupstream/operators:main#$OPERATORS_IMAGE#" -e "s#value: CLUSTER_ISSUER#value: $CLUSTER_ISSUER#" \
  "$ROOT/operators/deploy/routes-operator.yaml" |
  kubectl apply -f - >/dev/null
kubectl -n openupstream-system rollout status deployment/routes-operator --timeout=5m

kubectl apply -f "$ROOT/operators/deploy/services-rbac.yaml" >/dev/null
sed "s#ghcr.io/openupstream/operators:main#$OPERATORS_IMAGE#" "$ROOT/operators/deploy/services-operator.yaml" |
  kubectl apply -f - >/dev/null
kubectl -n openupstream-system rollout status deployment/services-operator --timeout=5m
