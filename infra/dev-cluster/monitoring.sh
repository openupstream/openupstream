#!/usr/bin/env bash
# The platform's own monitoring, after garage.sh and platform.sh
# (ARCHITECTURE.md, "Observability and customer logs"; decisions 106, 107):
#
# 1. kube-prometheus-stack: Prometheus and Alertmanager once per compute
#    Site, Grafana, node-exporter, kube-state-metrics, with alerts by e-mail
#    through SES and the Watchdog pinged to healthchecks.io;
# 2. the platform's scrape targets and alert rules (infra/monitoring);
# 3. Loki with its chunks in a Garage bucket of its own, and Alloy shipping
#    the platform's namespaces' logs to it.
#
# ALERT_EMAIL is where alerts go (never committed). The healthchecks.io ping
# URL is read from HEALTHCHECKS_URL_FILE, the SES key from the AWS profile
# SES_PROFILE (docs/self-hosting.md, sections 6 and 10).
#
# Needs: KUBECONFIG, kubectl, helm, node, aws.
set -euo pipefail

cd "$(dirname "$0")"
ROOT=$(git rev-parse --show-toplevel)
NS=monitoring
ALERT_EMAIL=${ALERT_EMAIL:?ALERT_EMAIL: where alerts go}
HEALTHCHECKS_URL_FILE=${HEALTHCHECKS_URL_FILE:-$HOME/.config/openupstream/healthchecks-ping-url-dev}
SES_PROFILE=${SES_PROFILE:-openupstream-ses}
SES_REGION=${SES_REGION:-eu-central-1}
LOKI_BUCKET=openupstream.platform-logs
GRAFANA_CHARTS=https://grafana.github.io/helm-charts

[[ -s $HEALTHCHECKS_URL_FILE ]] || { echo "no healthchecks.io ping URL in $HEALTHCHECKS_URL_FILE (docs/self-hosting.md, section 10)" >&2; exit 1; }

# Every Project's NetworkPolicy admits this namespace to its Databases'
# metrics ports (MONITORING_NAMESPACE in operators/src/kubernetes.ts).
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

# Alertmanager's SMTP password, derived from the send-only SES key, and the
# ping URL: straight from their files into the Secret. Read first: set -e
# does not see a failure inside $(…) in an argument.
SES_KEY_ID=$(aws configure get aws_access_key_id --profile "$SES_PROFILE")
SMTP_PASSWORD=$(aws configure get aws_secret_access_key --profile "$SES_PROFILE" | node "$ROOT/infra/monitoring/ses-smtp-password.mjs" "$SES_REGION")
kubectl -n "$NS" create secret generic alertmanager-credentials --dry-run=client -o yaml \
  --from-literal=smtp-password="$SMTP_PASSWORD" \
  --from-literal=watchdog-url="$(tr -d ' \n\r' <"$HEALTHCHECKS_URL_FILE")" | kubectl apply -f - >/dev/null
unset SMTP_PASSWORD

# Grafana's admin password, generated once and kept in the cluster.
if ! kubectl -n "$NS" get secret grafana-admin >/dev/null 2>&1; then
  kubectl -n "$NS" create secret generic grafana-admin \
    --from-literal=admin-user=admin --from-literal=admin-password="$(openssl rand -base64 24)" >/dev/null
fi

helm upgrade --install kube-prometheus-stack oci://ghcr.io/prometheus-community/charts/kube-prometheus-stack --version 93.1.1 \
  -n "$NS" -f "$ROOT/infra/monitoring/kube-prometheus-stack-values.yaml" \
  --set-string alerts.email="$ALERT_EMAIL" --set-string alerts.smtpUser="$SES_KEY_ID" \
  --set-string alerts.sesRegion="$SES_REGION" \
  --wait --timeout 10m >/dev/null
unset SES_KEY_ID
kubectl apply -f "$ROOT/infra/monitoring/scrape.yaml" -f "$ROOT/infra/monitoring/rules.yaml" >/dev/null

# Loki's bucket and its own key, created once through the garage CLI. The
# name has a dot, which customers' Bucket names cannot.
garage() { kubectl -n garage exec garage-0 -- /garage "$@"; }
if ! garage bucket info "$LOKI_BUCKET" >/dev/null 2>&1; then
  garage bucket create "$LOKI_BUCKET" >/dev/null
  garage key create loki >/dev/null
  garage bucket allow --read --write --key loki "$LOKI_BUCKET" >/dev/null
fi
key=$(garage key info --show-secret loki)
key_id=$(awk '/Key ID:/ {print $NF}' <<<"$key")
key_secret=$(awk '/Secret key:/ {print $NF}' <<<"$key")
unset key
[[ -n $key_id && -n $key_secret ]] || { echo "could not read the key 'loki' from garage key info" >&2; exit 1; }
kubectl -n "$NS" create secret generic loki-s3 --dry-run=client -o yaml \
  --from-literal=S3_ACCESS_KEY_ID="$key_id" \
  --from-literal=S3_SECRET_ACCESS_KEY="$key_secret" | kubectl apply -f - >/dev/null
unset key_id key_secret

helm upgrade --install loki loki --repo "$GRAFANA_CHARTS" --version 7.5.0 \
  -n "$NS" -f "$ROOT/infra/monitoring/loki-values.yaml" --wait --timeout 10m >/dev/null
helm upgrade --install alloy alloy --repo "$GRAFANA_CHARTS" --version 1.15.0 \
  -n "$NS" -f "$ROOT/infra/monitoring/alloy-values.yaml" --wait --timeout 5m >/dev/null

kubectl -n "$NS" get pods -o wide
echo "Grafana: kubectl -n $NS port-forward svc/kube-prometheus-stack-grafana 3000:80, user admin,"
echo "password: kubectl -n $NS get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d"
