#!/usr/bin/env bash
# Bootstraps the platform on the dev cluster, after operators.sh, ingress.sh
# and garage.sh. On a single-node cluster madAuth and the control plane run
# once instead of once per compute Site, and Databases get no standby
# (decision 112):
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
# 4. the dashboard (nginx with its static files) and the public hostname
#    (after ingress.sh): the dashboard at https://$PLATFORM_DOMAIN, madAuth
#    under /auth and the API under /api, with a certificate from
#    CLUSTER_ISSUER; with SIGNUP=closed also the waitlist page at
#    https://$WAITLIST_DOMAIN, with its DNS record and certificate;
# 5. the Databases operator, reconciling every 30 s with rows from the
#    control plane;
# 6. the Routes operator, turning the routing table into Traefik objects
#    every 30 s;
# 7. the Services operator, running every Service as a Deployment under
#    gVisor every 30 s;
# 8. the CPU agent on each compute node, every pod's CPU total for metering
#    (decision 115);
# 9. the bandwidth agent on each compute node, which keeps the customers'
#    pods from filling the node's uplink (decision 122). UPLINK_MBIT is the
#    nodes' uplink speed in Mbit/s, for nodes whose interface reports none
#    (VMs) or more than the line carries; unset, the interface's own.
#
# Images come from GHCR, pinned by digest: by default the ones built for the
# current commit (.github/workflows/images.yml). Override with IMAGE_TAG, a
# commit that has all three images: none from before the dashboard's image
# (decision 123) can be installed with this script.
#
# Needs: KUBECONFIG, kubectl, curl, jq, node, aws (for MAIL=ses), and with
# SIGNUP=closed the bunny.net API key (dns.sh).
set -euo pipefail

cd "$(dirname "$0")"
ROOT=$(git rev-parse --show-toplevel)
source ./lib.sh
load_layout
load_domains
IMAGE_TAG=${IMAGE_TAG:-$(git rev-parse HEAD)}
# The DatabaseConfig for the cluster's layout (database_config in lib.sh).
CONFIG=$(mktemp)
trap 'rm -f "$CONFIG"' EXIT
database_config >"$CONFIG"
PLATFORM_NS=project-00000000-0000-4000-8000-000000000002
PLATFORM_DB=db-00000000-0000-4000-8000-000000000003
AUTH_DB=db-00000000-0000-4000-8000-000000000004
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
# Who may sign up (decision 86). Open by default, as for anyone running
# openupstream themselves. The hosted service sets SIGNUP=closed until it
# can invoice: madAuth then refuses new users except the addresses and
# @domains in SIGNUP_ALLOW, and https://$WAITLIST_DOMAIN serves the
# waitlist: a host of its own (decision 123; openupstream.com for the hosted
# service at console.openupstream.com), a bunny.net zone or a name inside
# one. The waitlist also needs IMPRINT_FILE, a text file with the Impressum,
# and MAIL=ses or log for its confirmation e-mails.
SIGNUP=${SIGNUP:-open}
SIGNUP_ALLOW=${SIGNUP_ALLOW:-}
IMPRINT_FILE=${IMPRINT_FILE:-}
WAITLIST_DOMAIN=${WAITLIST_DOMAIN:-}
# The Project whose Routes serve the website at the waitlist's host
# (decision 131; docs/self-hosting.md, "The website"): it alone may claim
# that host as a custom domain. Set it once the Project exists and run this
# again; the waitlist then keeps /waitlist, /privacy and /imprint.
WEBSITE_PROJECT_ID=${WEBSITE_PROJECT_ID:-}
case $SIGNUP in
  open) ;;
  closed)
    [[ -n $WAITLIST_DOMAIN && $WAITLIST_DOMAIN != "$PLATFORM_DOMAIN" ]] ||
      { echo "SIGNUP=closed needs WAITLIST_DOMAIN, the waitlist's own host, e.g. waitlist.$PLATFORM_DOMAIN: $PLATFORM_DOMAIN serves the dashboard" >&2; exit 1; }
    [[ -f $IMPRINT_FILE ]] || { echo "SIGNUP=closed needs IMPRINT_FILE, the Impressum the waitlist shows" >&2; exit 1; }
    [[ $MAIL == ses || $MAIL == log ]] || { echo "SIGNUP=closed needs MAIL=ses or MAIL=log for the waitlist's e-mails" >&2; exit 1; } ;;
  *) echo "SIGNUP must be open or closed" >&2; exit 1 ;;
esac
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
DASHBOARD_IMAGE=$(digest dashboard)
echo "control plane: $CONTROL_PLANE_IMAGE"
echo "operators:     $OPERATORS_IMAGE"
echo "dashboard:     $DASHBOARD_IMAGE"

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
  --from-literal=WEBHOOK_EVENTS=email.send_verification,email.send_password_reset,email.send_already_registered,email.send_password_reset_no_password,user.signing_up \
  --from-literal=MAIL="$MAIL" \
  --from-literal=MAIL_FROM="$MAIL_FROM" \
  --from-literal=SES_REGION="${SES_REGION:-eu-central-1}" \
  --from-literal=SIGNUP="$SIGNUP" \
  --from-literal=SIGNUP_ALLOW="$SIGNUP_ALLOW" \
  --from-literal=SIGNUP_MESSAGE="Sign-up is not open yet.${WAITLIST_DOMAIN:+ Leave your e-mail address at https://$WAITLIST_DOMAIN to hear when it is.}" \
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

# The manifests run two replicas, one per compute Site; SITE_REPLICAS
# replaces that. Fails if a manifest no longer has that line, rather than
# silently running the multi-node count.
replicas() {
  local manifest
  manifest=$(sed "s#^  replicas: 2\$#  replicas: $SITE_REPLICAS#")
  grep -q "^  replicas: $SITE_REPLICAS\$" <<<"$manifest" ||
    { echo "no '  replicas: 2' in the manifest to set to $SITE_REPLICAS" >&2; return 1; }
  printf '%s\n' "$manifest"
}

sed "s#ghcr.io/openupstream/control-plane:main#$CONTROL_PLANE_IMAGE#" "$ROOT/infra/madauth/madauth.yaml" | replicas |
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

# The waitlist's settings (control-plane/src/config.ts); its e-mails use
# madAuth's send-only key from the Secret madauth-ses.
WAITLIST_CONFIG=()
if [[ $SIGNUP == closed ]]; then
  WAITLIST_CONFIG=(
    --from-literal=WAITLIST_URL="https://$WAITLIST_DOMAIN"
    --from-literal=WAITLIST_MAIL="$MAIL"
    --from-literal=MAIL_FROM="$MAIL_FROM"
    --from-literal=SES_REGION="${SES_REGION:-eu-central-1}"
    --from-file=WAITLIST_IMPRINT="$IMPRINT_FILE"
  )
fi
# The platform's Prometheus, which monitoring.sh installs before this step:
# what Resources use now, for the API and the dashboard (decision 124),
# metering (decision 114) and storage auto-grow (decision 111). Without it
# none of the three works; run this again after monitoring.sh.
PROMETHEUS_URL=""
if kubectl -n monitoring get service kube-prometheus-stack-prometheus >/dev/null 2>&1; then
  PROMETHEUS_URL=http://kube-prometheus-stack-prometheus.monitoring.svc:9090
else
  echo "no Prometheus (run monitoring.sh, then this again): usage is not shown, metered or grown on" >&2
fi
# A single node's local-path volumes are directories of its disk: they
# report that disk's use and cannot grow, so storage does not grow by itself
# there and a Database's disk use is read from Postgres (decisions 112, 124).
DATABASE_VOLUMES=dedicated
[[ $LAYOUT == single-node ]] && DATABASE_VOLUMES=shared
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
  --from-literal=CLI_CLIENT_ID="${CLI_CLIENT_ID:-}" \
  --from-literal=PROMETHEUS_URL="$PROMETHEUS_URL" \
  --from-literal=DATABASE_VOLUMES="$DATABASE_VOLUMES" \
  --from-literal=WEBSITE_PROJECT_ID="$WEBSITE_PROJECT_ID" \
  ${WAITLIST_CONFIG[@]+"${WAITLIST_CONFIG[@]}"} | kubectl apply -f - >/dev/null
sed "s#ghcr.io/openupstream/control-plane:main#$CONTROL_PLANE_IMAGE#" "$ROOT/control-plane/deploy/control-plane.yaml" | replicas |
  kubectl apply -f - >/dev/null
config_rollout control-plane control-plane-config
kubectl -n "$PLATFORM_NS" rollout status deployment/control-plane --timeout=5m

# The dashboard: static files, no settings.
sed "s#ghcr.io/openupstream/dashboard:main#$DASHBOARD_IMAGE#" "$ROOT/dashboard/deploy/dashboard.yaml" | replicas |
  kubectl apply -f - >/dev/null
kubectl -n "$PLATFORM_NS" rollout status deployment/dashboard --timeout=5m

sed -e "s#PLATFORM_DOMAIN#$PLATFORM_DOMAIN#g" -e "s#CLUSTER_ISSUER#$CLUSTER_ISSUER#g" "$ROOT/infra/ingress/platform-routes.yaml" |
  kubectl apply -f - >/dev/null
kubectl -n "$PLATFORM_NS" wait certificate/platform --for=condition=Ready --timeout=10m
if [[ $SIGNUP == closed ]]; then
  DNS_DOMAIN=$WAITLIST_DOMAIN ./dns.sh
  sed -e "s#WAITLIST_DOMAIN#$WAITLIST_DOMAIN#g" -e "s#CLUSTER_ISSUER#$CLUSTER_ISSUER#g" "$ROOT/infra/ingress/waitlist-route.yaml" |
    kubectl apply -f - >/dev/null
  kubectl -n "$PLATFORM_NS" wait certificate/waitlist --for=condition=Ready --timeout=10m
else
  kubectl delete -f "$ROOT/infra/ingress/waitlist-route.yaml" --ignore-not-found >/dev/null
fi

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

kubectl apply -f "$ROOT/operators/deploy/jobs-rbac.yaml" >/dev/null
sed "s#ghcr.io/openupstream/operators:main#$OPERATORS_IMAGE#" "$ROOT/operators/deploy/jobs-operator.yaml" |
  kubectl apply -f - >/dev/null
kubectl -n openupstream-system rollout status deployment/jobs-operator --timeout=5m

# The CPU agent on each compute node, for metering (decision 115).
sed "s#ghcr.io/openupstream/operators:main#$OPERATORS_IMAGE#" "$ROOT/operators/deploy/cpu-agent.yaml" |
  kubectl apply -f - >/dev/null
kubectl -n openupstream-system rollout status daemonset/cpu-agent --timeout=5m

# The bandwidth agent on each compute node, which keeps the customers' pods
# from filling the node's uplink (decision 122).
sed -e "s#ghcr.io/openupstream/operators:main#$OPERATORS_IMAGE#" \
  -e "s#{name: UPLINK_MBIT, value: \"\"}#{name: UPLINK_MBIT, value: \"${UPLINK_MBIT:-}\"}#" \
  "$ROOT/operators/deploy/bandwidth-agent.yaml" |
  kubectl apply -f - >/dev/null
kubectl -n openupstream-system rollout status daemonset/bandwidth-agent --timeout=5m
