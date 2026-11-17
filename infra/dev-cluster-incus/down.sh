#!/usr/bin/env bash
# Deletes everything up.sh created: the DNS records of the install
# (../dev-cluster/dns-delete-all.sh), the three VMs with their snapshots,
# the compute VMs' block volumes and the local state. Asks first: unlike
# the Hetzner cluster this one is meant to stay, and nothing on it but the
# Databases' backups survives. YES=1 skips the question.
set -euo pipefail

cd "$(dirname "$0")"
source ./lib.sh

if [[ ${YES:-} != 1 ]]; then
  read -r -p "delete the VMs $PREFIX-{${SITES[*]// /,}} and everything on them? [y/N] " answer
  [[ $answer == [yY] ]] || exit 1
fi

KUBECONFIG=$PWD/.state/kubeconfig ../dev-cluster/dns-delete-all.sh || true
for site in "${SITES[@]}"; do
  vm=$(instance "$site")
  incus info "$vm" >/dev/null 2>&1 || continue
  echo "deleting $vm"
  incus delete --force "$vm"
done
for site in "${SITES[@]}"; do
  [[ $site == "$THIRD_SITE" ]] && continue
  volume=$(volume_name "$site")
  incus storage volume show "$R$POOL" "$volume" >/dev/null 2>&1 || continue
  echo "deleting volume $volume"
  incus storage volume delete "$R$POOL" "$volume"
done
rm -rf .state
