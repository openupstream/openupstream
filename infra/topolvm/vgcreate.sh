#!/usr/bin/env bash
# Creates the LVM volume group `openupstream` that TopoLVM allocates the
# Databases' volumes from (values.yaml), on a compute node, from the block
# device given. Runs on the node as root. Idempotent: an existing volume
# group is left alone.
#
#   vgcreate.sh /dev/disk/by-id/scsi-0HC_Volume_123456   (dev cluster: a Hetzner Cloud Volume)
#   vgcreate.sh /dev/md0                                  (a server: its NVMe RAID)
set -euo pipefail

DEVICE=${1:?usage: vgcreate.sh <block device>}
VG=openupstream

command -v vgcreate >/dev/null || { apt-get update -qq && apt-get install -y -qq lvm2 >/dev/null; }
if vgs "$VG" >/dev/null 2>&1; then
  echo "volume group $VG exists"
  exit 0
fi
[[ -b $DEVICE ]] || { echo "$DEVICE is not a block device" >&2; exit 1; }
# Refuses a device with a filesystem or partition table on it: wipefs -n lists one.
[[ -z $(wipefs -n "$DEVICE") ]] || { echo "$DEVICE is not empty; wipe it by hand if it may be" >&2; exit 1; }
pvcreate -q "$DEVICE"
vgcreate -q "$VG" "$DEVICE"
vgs "$VG"
