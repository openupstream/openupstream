#!/usr/bin/env bash
# Installs what build step 1 needs on the dev cluster: cert-manager (with
# Certificates owning their Secrets), TopoLVM on the compute nodes' volume
# group (infra/topolvm; not on a single node, whose Databases use k3s's
# local-path storage, decision 112), CloudNativePG and the Barman Cloud Plugin, at the versions vendored in
# operators/crds, and makes the cluster survive a dark Site (ARCHITECTURE.md,
# "Sites and failure handling"):
#
# - CoreDNS and the CloudNativePG operator run twice, in two different
#   compute Sites (once on a single node, ARCHITECTURE.md, decision 112);
#   the Barman Cloud Plugin stays at one replica (only archiving waits for it).
#   With one replica each, a Site failure took DNS and failover down until
#   the pod was evicted (measured 2026-10-17). Each gets a
#   PodDisruptionBudget, so a drain stops one of them at a time.
#
# Then creates the platform's backup credentials Secret from the AWS CLI
# profile `openupstream-backup` (Hetzner Object Storage, separate project).
#
# Needs: KUBECONFIG pointing at the cluster, kubectl, helm, aws.
set -euo pipefail

cd "$(dirname "$0")"
source ./lib.sh
load_layout

CERT_MANAGER=v1.21.2
CNPG=1.31.0-rc1
BARMAN_CLOUD=v0.15.1
TOPOLVM_CHART=17.3.1
ROOT=$(git rev-parse --show-toplevel)

apply() { kubectl apply --server-side --force-conflicts -f "$1" >/dev/null; }

apply "https://github.com/cert-manager/cert-manager/releases/download/$CERT_MANAGER/cert-manager.yaml"
# A Certificate owns its Secret, so a custom domain's key goes when the
# Routes operator deletes the Certificate (ARCHITECTURE.md, decision 85).
# Applying the manifest resets the arguments, so this is added once per run.
args=$(kubectl -n cert-manager get deployment cert-manager -o jsonpath='{.spec.template.spec.containers[0].args}')
[[ $args == *enable-certificate-owner-ref* ]] ||
  kubectl -n cert-manager patch deployment cert-manager --type=json \
    -p '[{"op": "add", "path": "/spec/template/spec/containers/0/args/-", "value": "--enable-certificate-owner-ref=true"}]' >/dev/null
apply "https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v$CNPG/cnpg-$CNPG.yaml"
kubectl -n cert-manager rollout status deploy --timeout=5m
# Its webhook's certificate comes from cert-manager.
if [[ $LAYOUT == multi-node ]]; then
  helm upgrade --install topolvm topolvm --repo https://topolvm.github.io/topolvm --version "$TOPOLVM_CHART" \
    -n topolvm-system --create-namespace -f "$ROOT/infra/topolvm/values.yaml" --wait --timeout 5m >/dev/null
fi
kubectl -n cnpg-system rollout status deploy/cnpg-controller-manager --timeout=5m
apply "https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/$BARMAN_CLOUD/manifest.yaml"

# SITE_REPLICAS replicas, each in another Site. nodeTaintsPolicy Honor
# leaves out tainted nodes: the non-compute Sites, and a dead node (tainted
# unreachable), so the replacement of a pod from a dark Site still starts in
# another one.
# matchLabelKeys counts only the new revision's pods during a rollout. The
# operator elects a leader (--leader-elect is in its default args).
spread() { # namespace, deployment, pod label
  kubectl -n "$1" patch deployment "$2" --type merge -p "{\"spec\": {\"replicas\": $SITE_REPLICAS, \"template\": {\"spec\": {
    \"topologySpreadConstraints\": [{\"maxSkew\": 1, \"topologyKey\": \"topology.kubernetes.io/zone\",
      \"whenUnsatisfiable\": \"DoNotSchedule\", \"nodeTaintsPolicy\": \"Honor\", \"matchLabelKeys\": [\"pod-template-hash\"], \"labelSelector\": {\"matchLabels\": $3}}]}}}}" >/dev/null
  kubectl -n "$1" rollout status deployment "$2" --timeout=5m
}
spread cnpg-system cnpg-controller-manager '{"app.kubernetes.io/name": "cloudnative-pg"}'
# k3s's CoreDNS manifest already spreads by zone and leaves replicas unset,
# so the scale survives k3s re-applying it.
kubectl -n kube-system scale deployment coredns --replicas="$SITE_REPLICAS" >/dev/null
kubectl -n kube-system rollout status deployment coredns --timeout=5m

# A drain stops one of them at a time, the next only once the first one's
# replacement is ready (ARCHITECTURE.md, decision 157). A pod that is not
# ready may always go, so a broken one never blocks a drain.
budget() { # namespace, name, pod labels
  kubectl -n "$1" apply -f - >/dev/null <<EOF
{"apiVersion": "policy/v1", "kind": "PodDisruptionBudget", "metadata": {"name": "$2"},
 "spec": {"maxUnavailable": 1, "unhealthyPodEvictionPolicy": "AlwaysAllow", "selector": {"matchLabels": $3}}}
EOF
}
budget cnpg-system cnpg-controller-manager '{"app.kubernetes.io/name": "cloudnative-pg"}'
budget kube-system coredns '{"k8s-app": "kube-dns"}'

# set -e does not see a failure inside $(…) in an argument; read first.
ACCESS_KEY_ID=$(aws configure get aws_access_key_id --profile openupstream-backup)
ACCESS_SECRET_KEY=$(aws configure get aws_secret_access_key --profile openupstream-backup)
kubectl create namespace openupstream-system --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n openupstream-system create secret generic backup-s3 --dry-run=client -o yaml \
  --from-literal=ACCESS_KEY_ID="$ACCESS_KEY_ID" --from-literal=ACCESS_SECRET_KEY="$ACCESS_SECRET_KEY" |
  kubectl apply -f - >/dev/null

kubectl get pods -A -o wide | awk 'NR == 1 || /cnpg|barman|coredns|topolvm/ {print $1, $2, $4, $8}' | column -t
# What each compute node can still give to Databases.
if [[ $LAYOUT == multi-node ]]; then
  kubectl get csistoragecapacities -n topolvm-system -o custom-columns=NODE:.nodeTopology.matchLabels,CAPACITY:.capacity
fi
