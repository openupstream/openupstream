# The k3s server arguments every node of a multi-node dev cluster gets,
# shared by ../dev-cluster-hetzner/up.sh and ../dev-cluster-incus/up.sh so
# both stay as production is set up. Sourced, not run.
#
# A dark node is marked NotReady after 20 s instead of 50 s, and its pods
# are replaced 30 s later instead of 300 s, so a dark Site's Services and
# system pods move within about a minute (ARCHITECTURE.md, decision 46).
k3s_server_args() { # site, node address → arguments, one line
  echo "--flannel-backend=wireguard-native \
--node-label topology.kubernetes.io/zone=$1 \
--tls-san $2 \
--secrets-encryption \
--kube-apiserver-arg default-not-ready-toleration-seconds=30 \
--kube-apiserver-arg default-unreachable-toleration-seconds=30 \
--kube-controller-manager-arg node-monitor-grace-period=20s \
--disable traefik --disable servicelb"
}
