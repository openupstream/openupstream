#!/usr/bin/env bash
# Installs what build step 1 needs on the dev cluster: cert-manager,
# CloudNativePG and the Barman Cloud Plugin, at the versions vendored in
# operators/crds, and makes the cluster survive a dark Site (ARCHITECTURE.md,
# "Sites and failure handling"):
#
# - CoreDNS and the CloudNativePG operator run twice, one per compute Site;
#   the Barman Cloud Plugin stays at one replica (only archiving waits for it).
#   With one replica each, a Site failure took DNS and failover down until
#   the pod was evicted (measured 2026-10-17).
#
# Then creates the platform's backup credentials Secret from the AWS CLI
# profile `openupstream-backup` (Hetzner Object Storage, separate project).
#
# Needs: KUBECONFIG pointing at the cluster, kubectl, aws.
set -euo pipefail

CERT_MANAGER=v1.21.2
CNPG=1.30.1
BARMAN_CLOUD=v0.15.1

apply() { kubectl apply --server-side --force-conflicts -f "$1" >/dev/null; }

apply "https://github.com/cert-manager/cert-manager/releases/download/$CERT_MANAGER/cert-manager.yaml"
# A Certificate owns its Secret, so a custom domain's key goes when the
# Routes operator deletes the Certificate (ARCHITECTURE.md, decision 85).
# Applying the manifest resets the arguments, so this is added once per run.
kubectl -n cert-manager get deployment cert-manager -o jsonpath='{.spec.template.spec.containers[0].args}' |
  grep -q enable-certificate-owner-ref ||
  kubectl -n cert-manager patch deployment cert-manager --type=json \
    -p '[{"op": "add", "path": "/spec/template/spec/containers/0/args/-", "value": "--enable-certificate-owner-ref=true"}]' >/dev/null
apply "https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v$CNPG/cnpg-$CNPG.yaml"
kubectl -n cert-manager rollout status deploy --timeout=5m
kubectl -n cnpg-system rollout status deploy/cnpg-controller-manager --timeout=5m
apply "https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/$BARMAN_CLOUD/manifest.yaml"

# One replica per compute Site. nodeTaintsPolicy Honor leaves out tainted
# nodes: the third Site, and a dead node (tainted unreachable), so the
# replacement of a pod from a dark Site still starts in the other one.
# matchLabelKeys counts only the new revision's pods during a rollout. The
# operator elects a leader (--leader-elect is in its default args).
spread() { # namespace, deployment, pod label
  kubectl -n "$1" patch deployment "$2" --type merge -p "{\"spec\": {\"replicas\": 2, \"template\": {\"spec\": {
    \"topologySpreadConstraints\": [{\"maxSkew\": 1, \"topologyKey\": \"topology.kubernetes.io/zone\",
      \"whenUnsatisfiable\": \"DoNotSchedule\", \"nodeTaintsPolicy\": \"Honor\", \"matchLabelKeys\": [\"pod-template-hash\"], \"labelSelector\": {\"matchLabels\": $3}}]}}}}" >/dev/null
  kubectl -n "$1" rollout status deployment "$2" --timeout=5m
}
spread cnpg-system cnpg-controller-manager '{"app.kubernetes.io/name": "cloudnative-pg"}'
# k3s's CoreDNS manifest already spreads by zone and leaves replicas unset,
# so the scale survives k3s re-applying it.
kubectl -n kube-system scale deployment coredns --replicas=2 >/dev/null
kubectl -n kube-system rollout status deployment coredns --timeout=5m

# set -e does not see a failure inside $(…) in an argument; read first.
ACCESS_KEY_ID=$(aws configure get aws_access_key_id --profile openupstream-backup)
ACCESS_SECRET_KEY=$(aws configure get aws_secret_access_key --profile openupstream-backup)
kubectl create namespace openupstream-system --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n openupstream-system create secret generic backup-s3 --dry-run=client -o yaml \
  --from-literal=ACCESS_KEY_ID="$ACCESS_KEY_ID" --from-literal=ACCESS_SECRET_KEY="$ACCESS_SECRET_KEY" |
  kubectl apply -f - >/dev/null

kubectl get pods -A -o wide | awk 'NR == 1 || /cnpg|barman|coredns/ {print $1, $2, $4, $8}' | column -t
