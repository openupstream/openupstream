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
# snapshotted and restored with them. The cluster is down for the
# minute or two this takes.
set -euo pipefail

cd "$(dirname "$0")"
source ./lib.sh

usage() { echo "usage: ./snapshot.sh create|restore|delete <name> | list" >&2; exit 2; }
ACTION=${1:-}
NAME=${2:-}
[[ $ACTION == list || -n $NAME ]] || usage

# Name check up front, so a typo stops nothing.
[[ $ACTION == list || $NAME =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "invalid name: $NAME" >&2; exit 2; }

volumes() { # the compute Sites' block volumes
  for site in "${SITES[@]}"; do
    [[ $site == "$THIRD_SITE" ]] || volume_name "$site"
  done
}
stop_all() { for site in "${SITES[@]}"; do incus stop "$(instance "$site")" 2>/dev/null || true; done; }
start_all() { for site in "${SITES[@]}"; do incus start "$(instance "$site")" 2>/dev/null || true; done; }
# Once the VMs are stopped, a failure starts them again instead of leaving
# the cluster down; after a failed restore some VMs may be restored and
# others not, so it says to restore again.
stop_all_guarded() { # [note for a failure]
  trap "echo \"$ACTION failed; starting the VMs again${1:+ ($1)}\" >&2; start_all" ERR
  stop_all
}

case $ACTION in
  list)
    for site in "${SITES[@]}"; do
      echo "$(instance "$site"):"
      incus snapshot list "$(instance "$site")" --format csv | sed 's/^/  /'
    done
    ;;
  create)
    stop_all_guarded
    for site in "${SITES[@]}"; do incus snapshot create "$(instance "$site")" "$NAME"; done
    for volume in $(volumes); do incus storage volume snapshot create "$R$POOL" "$volume" "$NAME"; done
    start_all
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
    stop_all_guarded "some may be restored and others not: run the restore again"
    for site in "${SITES[@]}"; do incus snapshot restore "$(instance "$site")" "$NAME"; done
    for volume in $(volumes); do incus storage volume snapshot restore "$R$POOL" "$volume" "$NAME"; done
    start_all
    echo "snapshot $NAME restored"
    ;;
  delete)
    for site in "${SITES[@]}"; do incus snapshot delete "$(instance "$site")" "$NAME" || true; done
    for volume in $(volumes); do incus storage volume snapshot delete "$R$POOL" "$volume" "$NAME" || true; done
    ;;
  *) usage ;;
esac
