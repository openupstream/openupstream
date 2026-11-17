# Shared by up.sh, down.sh and snapshot.sh; sourced, not run.

PREFIX=${PREFIX:-oup-home}
SITES=(hetzner-fsn1 ovh-lim netcup-nbg)
THIRD_SITE=netcup-nbg
POOL=${POOL:-default}
# `remote:` in front of every instance, pool and API path when the host is
# an Incus remote, nothing on the host itself.
R=${INCUS_REMOTE:+$INCUS_REMOTE:}

instance() { echo "$R$PREFIX-$1"; }   # site → instance, as incus takes it
volume_name() { echo "$PREFIX-$1-lvm"; } # compute site → its block volume

# The VM's IPv4 address on the home network, from its state in the Incus
# API (stdin): the first global one on an ethX or enpX interface, so k3s's
# own interfaces (cni0, flannel-wg) never count.
vm_ipv4() {
  jq -r '[.network // {} | to_entries[] | select(.key | test("^(eth|en)")) |
    .value.addresses[] | select(.family == "inet" and .scope == "global") | .address][0] // empty'
}
# Runs a check every 2 s until it succeeds; gives up after WAIT_SECONDS
# (default 300) with what it waited for: until_ok "description" command...
until_ok() {
  local what=$1 deadline=$((SECONDS + ${WAIT_SECONDS:-300}))
  shift
  until "$@"; do
    ((SECONDS < deadline)) || { echo "gave up waiting for $what" >&2; exit 1; }
    sleep 2
  done
}
vm_state() { incus query "$R/1.0/instances/$PREFIX-$1/state"; } # site → state JSON
