#!/usr/bin/env bash
# Installs gVisor (runsc) on a compute node and adds it to k3s's containerd as
# the runtime handler `runsc`, which the RuntimeClass `gvisor`
# (runtimeclass.yaml) names (ARCHITECTURE.md, decision 90). k3s does not
# detect runsc on its own.
#
# Run as root on the node, before k3s is installed or followed by
# `systemctl restart k3s`: k3s renders containerd's config from the template
# at start. Customer containers run only under this runtime, so the release
# is pinned and its archive checked against the hash recorded here, not
# against one downloaded next to it.
set -euo pipefail

GVISOR_RELEASE=20261012
GVISOR_SHA512=9606445eed5aedfcf05310e7ccef61d994089914c6622fc82624c24d2b18db1b2210f40e40a7be27b8b7772859de7d95c501b4eba66423053c960bf671377c5e
[[ $(uname -m) == x86_64 ]] || { echo "only x86_64 is pinned" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/gvisor.tar.bz2" \
  "https://storage.googleapis.com/gvisor/releases/release/$GVISOR_RELEASE/x86_64/gvisor.tar.bz2"
echo "$GVISOR_SHA512  $work/gvisor.tar.bz2" | sha512sum -c --quiet
tar -xjf "$work/gvisor.tar.bz2" -C "$work" runsc containerd-shim-runsc-v1
install -m 755 "$work/runsc" "$work/containerd-shim-runsc-v1" /usr/local/bin/

# k3s 1.31 and later run containerd 2 with config version 3; the template
# extends k3s's own configuration instead of replacing it.
mkdir -p /var/lib/rancher/k3s/agent/etc/containerd
cat >/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl <<'TOML'
{{ template "base" . }}

[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"
TOML
runsc --version | head -1
