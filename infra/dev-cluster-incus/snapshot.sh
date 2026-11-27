#!/usr/bin/env bash
# Saves or restores all three VMs of up.sh together, e.g. before trying a
# change of openupstream on a cluster whose Projects should survive it.
#
#   ./snapshot.sh create <name>    stop the VMs, snapshot each, start them
#   ./snapshot.sh restore <name>   stop the VMs, restore each, start them
#   ./snapshot.sh list
#   ./snapshot.sh delete <name>
#
# The VMs are stopped for create and restore: snapshots of running etcd
# members taken one after another would not agree with each other, and a
# Postgres primary and its standby would be restored from different
# moments. The compute VMs' block volumes (the Databases' data, TopoLVM) are
# snapshotted and restored with them. The cluster is down for the two or
# three minutes this takes.
#
# Every Database is hibernated first (CloudNativePG's cnpg.io/hibernation
# annotation: Postgres stops cleanly, the volumes and the primary stay) and
# woken once the VMs are back. Without it, a primary on a VM that stops
# first, or boots last, fails over, and the old primary of a platform
# Database cannot rejoin while its archive check fails
# (../dev-cluster/README.md). A snapshot thus holds hibernated Databases,
# and restore wakes them. Needs kubectl and .state/kubeconfig (KUBECONFIG);
# without a kubeconfig, it skips this.
set -euo pipefail

cd "$(dirname "$0")"
source ./lib.sh

usage() { echo "usage: ./snapshot.sh create|restore|delete <name> | list" >&2; exit 2; }
ACTION=${1:-}
NAME=${2:-}
[[ $ACTION == list || -n $NAME ]] || usage

# Name check up front, so a typo stops nothing.
[[ $ACTION == list || $NAME =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "invalid name: $NAME" >&2; exit 2; }

export KUBECONFIG=${KUBECONFIG:-$PWD/.state/kubeconfig}
DATABASES=clusters.postgresql.cnpg.io

volumes() { # the compute Sites' block volumes
  for site in "${SITES[@]}"; do
    [[ $site == "$THIRD_SITE" ]] || volume_name "$site"
  done
}
no_postgres() { [[ -z $(kubectl get pods -A -l cnpg.io/podRole=instance -o name) ]]; }
# Databases exist once the platform is installed; before that, nothing to do.
databases() { [[ -f $KUBECONFIG && -n $(kubectl get "$DATABASES" -A -o name 2>/dev/null) ]]; }
hibernate() {
  databases || return 0
  echo "hibernating the Databases"
  kubectl annotate "$DATABASES" --all -A cnpg.io/hibernation=on --overwrite >/dev/null
  until_ok "every Postgres instance to stop" no_postgres
}
# The snapshot (or a failed attempt) left the Databases hibernated. Right
# after a start the API, and then CloudNativePG's admission webhook, refuse
# for a while, so both are retried.
api_ready() { kubectl get --raw /readyz >/dev/null 2>&1; }
unhibernate() { kubectl annotate "$DATABASES" --all -A cnpg.io/hibernation=off --overwrite >/dev/null 2>&1; }
wake() {
  [[ -f $KUBECONFIG ]] || return 0
  until_ok "the Kubernetes API" api_ready
  echo "waking the Databases"
  until_ok "CloudNativePG to accept the wake-up" unhibernate
}
# All three at once, so the cluster goes down in one step.
stop_all() {
  local site
  for site in "${SITES[@]}"; do incus stop "$(instance "$site")" 2>/dev/null & done
  wait
}
start_all() { for site in "${SITES[@]}"; do incus start "$(instance "$site")" 2>/dev/null || true; done; }
# Once the VMs are stopped, a failure starts them and wakes the Databases
# again instead of leaving the cluster down; after a failed restore some
# VMs may be restored and others not, so it says to restore again. Set at
# the call site: bash keeps an ERR trap set inside a function from
# replacing one set outside it.
recover() { # [note]
  echo "$ACTION failed; starting the VMs again${1:+ ($1)}" >&2
  start_all
  wake
}

case $ACTION in
  list)
    for site in "${SITES[@]}"; do
      echo "$(instance "$site"):"
      incus snapshot list "$(instance "$site")" --format csv | sed 's/^/  /'
    done
    ;;
  create)
    trap 'echo "create failed; waking the Databases again" >&2; wake' ERR
    hibernate
    trap recover ERR
    stop_all
    for site in "${SITES[@]}"; do incus snapshot create "$(instance "$site")" "$NAME"; done
    for volume in $(volumes); do incus storage volume snapshot create "$R$POOL" "$volume" "$NAME"; done
    start_all
    wake
    echo "snapshot $NAME created"
    ;;
  restore)
    # Every VM and volume must have it before anything is touched.
    for site in "${SITES[@]}"; do
      incus snapshot show "$(instance "$site")" "$NAME" >/dev/null ||
        { echo "$(instance "$site") has no snapshot $NAME" >&2; exit 1; }
    done
    for volume in $(volumes); do
      incus storage volume snapshot show "$R$POOL" "$volume" "$NAME" >/dev/null ||
        { echo "volume $volume has no snapshot $NAME" >&2; exit 1; }
    done
    trap 'recover "some may be restored and others not: run the restore again"' ERR
    stop_all
    for site in "${SITES[@]}"; do incus snapshot restore "$(instance "$site")" "$NAME"; done
    for volume in $(volumes); do incus storage volume snapshot restore "$R$POOL" "$volume" "$NAME"; done
    start_all
    wake
    echo "snapshot $NAME restored"
    ;;
  delete)
    for site in "${SITES[@]}"; do incus snapshot delete "$(instance "$site")" "$NAME" || true; done
    for volume in $(volumes); do incus storage volume snapshot delete "$R$POOL" "$volume" "$NAME" || true; done
    ;;
  *) usage ;;
esac
