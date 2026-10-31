#!/usr/bin/env bash
# Installs gVisor (runsc) on a compute node and adds it to k3s's containerd as
# the runtime handler `runsc`, which the RuntimeClass `gvisor`
# (runtimeclass.yaml) names (ARCHITECTURE.md, decision 90). k3s does not
# detect runsc on its own.
#
# Run as root on the node, ideally before k3s is installed: k3s renders
# containerd's config from the template at start, so on a node where it
# already runs this restarts it. Customer containers run only under this runtime, so the release
# is pinned and its archive checked against the hash recorded here, not
# against one downloaded next to it.
set -euo pipefail

GVISOR_RELEASE=20261012
GVISOR_SHA512=9606445eed5aedfcf05310e7ccef61d994089914c6622fc82624c24d2b18db1b2210f40e40a7be27b8b7772859de7d95c501b4eba66423053c960bf671377c5e
[[ $(uname -m) == x86_64 ]] || { echo "only x86_64 is pinned" >&2; exit 1; }

# The archive is bzip2; minimal images (Ubuntu's cloud image) lack it.
command -v bzip2 >/dev/null || { apt-get update -qq && apt-get install -y -qq bzip2 >/dev/null; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL -o "$work/gvisor.tar.bz2" \
  "https://storage.googleapis.com/gvisor/releases/release/$GVISOR_RELEASE/x86_64/gvisor.tar.bz2"
echo "$GVISOR_SHA512  $work/gvisor.tar.bz2" | sha512sum -c --quiet
# runsc looks for its helpers (the Sentry and others) in gvisor-bin/ next to
# itself, so the whole release goes into /usr/local/bin.
tar -xjf "$work/gvisor.tar.bz2" -C "$work"
install -m 755 "$work/runsc" "$work/containerd-shim-runsc-v1" /usr/local/bin/
rm -rf /usr/local/bin/gvisor-bin
cp -a "$work/gvisor-bin" /usr/local/bin/gvisor-bin

# k3s 1.31 and later run containerd 2 with config version 3; the template
# extends k3s's own configuration instead of replacing it.
mkdir -p /var/lib/rancher/k3s/agent/etc/containerd
cat >/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl <<'TOML'
{{ template "base" . }}

[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"
TOML
runsc --version | head -1
# A k3s that already runs renders the template only when it starts again.
if systemctl is-active --quiet k3s; then
  systemctl restart k3s
fi
