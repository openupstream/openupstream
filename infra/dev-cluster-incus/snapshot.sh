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
# On the Databases this script hibernated, so it wakes only those, not one
# someone hibernated on purpose. A snapshot keeps the label with them.
MARK=openupstream.io/snapshot-hibernated

volumes() { # the compute Sites' block volumes
  for site in "${SITES[@]}"; do
    [[ $site == "$QUORUM_SITE" ]] || volume_name "$site"
  done
}
no_postgres() {
  local pods
  pods=$(kubectl get pods -A -l cnpg.io/podRole=instance -o name) || return 1
  [[ -z $pods ]]
}
# Databases exist once the platform is installed; before that, nothing to do.
databases() { [[ -f $KUBECONFIG && -n $(kubectl get "$DATABASES" -A -o name 2>/dev/null) ]]; }
hibernate() {
  databases || return 0
  echo "hibernating the Databases"
  local namespace name
  kubectl get "$DATABASES" -A -o json |
    jq -r '.items[] | select(.metadata.annotations["cnpg.io/hibernation"] != "on") | "\(.metadata.namespace) \(.metadata.name)"' |
    while read -r namespace name; do
      kubectl -n "$namespace" label "$DATABASES" "$name" "$MARK=true" --overwrite >/dev/null
      kubectl -n "$namespace" annotate "$DATABASES" "$name" cnpg.io/hibernation=on --overwrite >/dev/null
    done
  until_ok "every Postgres instance to stop" no_postgres
}
# The snapshot (or a failed attempt) left the Databases hibernated. Right
# after a start the API, and then CloudNativePG's admission webhook, refuse
# for a while, so both are retried.
api_ready() { kubectl get --raw /readyz >/dev/null 2>&1; }
unhibernate() {
  local marked
  marked=$(kubectl get "$DATABASES" -A -l "$MARK" -o name 2>/dev/null) || return 1
  [[ -z $marked ]] && return 0
  kubectl annotate "$DATABASES" -A -l "$MARK" cnpg.io/hibernation=off --overwrite >/dev/null 2>&1 &&
    kubectl label "$DATABASES" -A -l "$MARK" "$MARK-" >/dev/null 2>&1
}
wake() {
  [[ -f $KUBECONFIG ]] || return 0
  until_ok "the Kubernetes API" api_ready
  echo "waking the Databases"
  until_ok "CloudNativePG to accept the wake-up" unhibernate
}
# All three at once, so the cluster goes down in one step; then each must
# report Stopped, or the snapshot would be of a running VM.
stop_all() {
  local site
  for site in "${SITES[@]}"; do incus stop "$(instance "$site")" 2>/dev/null & done
  wait
  for site in "${SITES[@]}"; do
    [[ $(vm_state "$site" | jq -r .status) == Stopped ]] ||
      { echo "$(instance "$site") did not stop" >&2; return 1; }
  done
}
start_all() { for site in "${SITES[@]}"; do incus start "$(instance "$site")" 2>/dev/null || true; done; }

# A failure anywhere, a wait that gives up included (until_ok exits, which
# no ERR trap sees), starts the VMs and wakes the Databases again instead of
# leaving the cluster down. After a failed restore some VMs may be restored
# and others not, so it says to restore again.
STOPPED=0 HIBERNATED=0 DONE=0 NOTE=
cleanup() {
  [[ $DONE == 1 || ( $STOPPED == 0 && $HIBERNATED == 0 ) ]] && return
  echo "$ACTION failed${NOTE:+ ($NOTE)}; starting the VMs and waking the Databases again" >&2
  [[ $STOPPED == 1 ]] && start_all
  [[ $HIBERNATED == 1 ]] && wake
}
trap cleanup EXIT

case $ACTION in
  list)
    DONE=1
    for site in "${SITES[@]}"; do
      echo "$(instance "$site"):"
      incus snapshot list "$(instance "$site")" --format csv | sed 's/^/  /'
    done
    ;;
  create)
    HIBERNATED=1
    hibernate
    STOPPED=1
    stop_all
    for site in "${SITES[@]}"; do incus snapshot create "$(instance "$site")" "$NAME"; done
    for volume in $(volumes); do incus storage volume snapshot create "$R$POOL" "$volume" "$NAME"; done
    start_all
    wake
    DONE=1
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
    # Hibernated here too, so a failed restore does not boot the old VMs
    # into a failover; best effort, since a broken cluster is what one
    # restores from. The restored Databases are hibernated either way.
    HIBERNATED=1
    (hibernate) || echo "could not hibernate the Databases; restoring anyway" >&2
    NOTE="some may be restored and others not: run the restore again"
    STOPPED=1
    stop_all
    for site in "${SITES[@]}"; do incus snapshot restore "$(instance "$site")" "$NAME"; done
    for volume in $(volumes); do incus storage volume snapshot restore "$R$POOL" "$volume" "$NAME"; done
    start_all
    wake
    DONE=1
    echo "snapshot $NAME restored"
    ;;
  delete)
    DONE=1
    for site in "${SITES[@]}"; do incus snapshot delete "$(instance "$site")" "$NAME" || true; done
    for volume in $(volumes); do incus storage volume snapshot delete "$R$POOL" "$volume" "$NAME" || true; done
    ;;
  *) usage ;;
esac
