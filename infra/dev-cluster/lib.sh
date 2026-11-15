# Sourced by the install steps (operators.sh, ingress.sh, garage.sh,
# platform.sh, monitoring.sh) and the two entry scripts. Not run on its own.
#
# The cluster's layout (ARCHITECTURE.md, decision 109) is recorded once by
# install-single-node.sh or install-multi-node.sh in the ConfigMap
# openupstream-system/cluster-layout, so a step run again on its own (e.g.
# platform.sh for CLI_CLIENT_ID) installs the same way as the first time:
#
# - multi-node: one node per Site, the layout of production;
# - single-node: one node standing in for every Site, one copy of
#   everything, no failover. For development only.

LAYOUT_NAMESPACE=openupstream-system
LAYOUT_CONFIGMAP=cluster-layout
# The Sites' nodes carry these names as topology.kubernetes.io/zone.
SITES=(hetzner-fsn1 ovh-lim netcup-nbg)
COMPUTE_SITES=(hetzner-fsn1 ovh-lim)
# The single node is labeled as this compute Site.
SINGLE_NODE_SITE=hetzner-fsn1

# Prints the recorded layout; fails if none is recorded or the cluster
# cannot be read. Checked explicitly: called as $(cluster_layout), where
# set -e does not apply.
cluster_layout() {
  local layout
  if ! layout=$(kubectl -n "$LAYOUT_NAMESPACE" get configmap "$LAYOUT_CONFIGMAP" --ignore-not-found -o jsonpath='{.data.layout}'); then
    echo "cannot read $LAYOUT_NAMESPACE/$LAYOUT_CONFIGMAP; is KUBECONFIG right?" >&2
    return 1
  fi
  case $layout in
    single-node | multi-node) echo "$layout" ;;
    *)
      echo "no cluster layout recorded in $LAYOUT_NAMESPACE/$LAYOUT_CONFIGMAP;" \
        "run install-single-node.sh or install-multi-node.sh first" >&2
      return 1
      ;;
  esac
}

# Records the layout; refuses to change one already recorded.
record_layout() { # single-node | multi-node
  local recorded
  recorded=$(kubectl -n "$LAYOUT_NAMESPACE" get configmap "$LAYOUT_CONFIGMAP" --ignore-not-found -o jsonpath='{.data.layout}')
  if [[ -n $recorded && $recorded != "$1" ]]; then
    echo "this cluster was installed as $recorded; it cannot become $1" >&2
    return 1
  fi
  kubectl create namespace "$LAYOUT_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl -n "$LAYOUT_NAMESPACE" create configmap "$LAYOUT_CONFIGMAP" --dry-run=client -o yaml \
    --from-literal=layout="$1" | kubectl apply -f - >/dev/null
}

# Sets LAYOUT and what depends on it: SITE_REPLICAS, how many replicas run
# of what runs once per compute Site, and the default CLUSTER_ISSUER. A
# single-node cluster uses Let's Encrypt's production issuer, since it lives
# longer than one session and staging certificates are not trusted.
load_layout() {
  LAYOUT=$(cluster_layout)
  if [[ $LAYOUT == single-node ]]; then
    SITE_REPLICAS=1
    CLUSTER_ISSUER=${CLUSTER_ISSUER:-letsencrypt}
  else
    SITE_REPLICAS=2
    CLUSTER_ISSUER=${CLUSTER_ISSUER:-letsencrypt-staging}
  fi
}

# Sets PLATFORM_DOMAIN (decision 67) and CUSTOMER_DOMAIN (decision 68), after
# load_layout. The defaults are the Hetzner dev cluster's zones. A
# single-node cluster has none, so it never takes over the shared dev zones
# by accident.
load_domains() {
  if [[ $LAYOUT == single-node ]]; then
    PLATFORM_DOMAIN=${PLATFORM_DOMAIN:?single-node: set PLATFORM_DOMAIN, e.g. home.example.com}
    CUSTOMER_DOMAIN=${CUSTOMER_DOMAIN:?single-node: set CUSTOMER_DOMAIN, e.g. home.example.app}
  else
    PLATFORM_DOMAIN=${PLATFORM_DOMAIN:-dev.openupstream.com}
    CUSTOMER_DOMAIN=${CUSTOMER_DOMAIN:-dev.openupstream.app}
  fi
}
