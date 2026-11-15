# containerd's AppArmor profile for every container on a k3s node, as
# containerd 2.3 generates it (contrib/apparmor/template.go, rendered with
# the daemon running unconfined), plus the two rules marked below
# (ARCHITECTURE.md, decision 110).
#
# Ubuntu 26.04 sets kernel.apparmor_restrict_unprivileged_unconfined=1, so
# runc stacks this profile on `unconfined` and a container's processes are
# labelled cri-containerd.apparmor.d//&unconfined. containerd's own rules
# only name cri-containerd.apparmor.d, so the processes of one container
# cannot signal each other: Postgres fails with "could not signal for
# checkpoint: Permission denied" (containerd issue #14485, fix #14487).
#
# containerd loads its built-in profile only when none of this name is
# loaded, so this one must be in /etc/apparmor.d and loaded before k3s
# starts (infra/dev-cluster/k3s-single-node.sh does both). Delete it once
# k3s ships a containerd with #14487.

#include <tunables/global>

profile cri-containerd.apparmor.d flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>

  network,
  capability,
  file,
  umount,
  # Host (privileged) processes may send signals to container processes.
  signal (receive) peer=unconfined,
  # runc may send signals to container processes.
  signal (receive) peer=runc,
  # crun may send signals to container processes.
  signal (receive) peer=crun,
  # Container processes may send signals amongst themselves.
  signal (send,receive) peer=cri-containerd.apparmor.d,
  # Added: the same for the stacked label of Ubuntu 26.04 (#14487).
  signal (send,receive) peer=cri-containerd.apparmor.d//&unconfined,

  deny @{PROC}/* w,   # deny write for all files directly in /proc (not in a subdir)
  # deny write to files not in /proc/<number>/** or /proc/sys/**
  deny @{PROC}/{[^1-9/],[^1-9/][^0-9/],[^1-9s/][^0-9y/][^0-9s/],[^1-9/][^0-9/][^0-9/][^0-9/]*}/** w,
  deny @{PROC}/sys/[^k]** w,  # deny /proc/sys except /proc/sys/k* (effectively /proc/sys/kernel)
  deny @{PROC}/sys/kernel/{?,??,[^s][^h][^m]**} w,  # deny everything except shm* in /proc/sys/kernel/
  deny @{PROC}/sysrq-trigger rwklx,
  deny @{PROC}/kcore rwklx,
  deny mount,
  deny /sys/[^f]*/** wklx,
  deny /sys/f[^s]*/** wklx,
  deny /sys/fs/[^c]*/** wklx,
  deny /sys/fs/c[^g]*/** wklx,
  deny /sys/fs/cg[^r]*/** wklx,
  deny /sys/firmware/** rwklx,
  deny /sys/devices/virtual/powercap/** rwklx,
  deny /sys/kernel/security/** rwklx,

  # allow processes within the container to trace each other,
  # provided all other LSM and yama setting allow it.
  ptrace (trace,tracedby,read,readby) peer=cri-containerd.apparmor.d,
  # Added: the same for the stacked label of Ubuntu 26.04 (#14487).
  ptrace (trace,tracedby,read,readby) peer=cri-containerd.apparmor.d//&unconfined,
}
