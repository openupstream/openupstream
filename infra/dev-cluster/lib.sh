# Sourced by the install steps (operators.sh, ingress.sh, garage.sh,
# platform.sh, monitoring.sh) and the two entry scripts. Not run on its own.
#
# The cluster's layout (ARCHITECTURE.md, decision 112) is recorded once by
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

# The cluster's id, recorded next to the layout: its folder in the backup
# bucket (decision 149), so clusters sharing the bucket, and a cluster
# installed again, never find each other's archives. Generated once per
# install as <date>-<random>; CLUSTER_ID chooses it (e.g. production).
# Fails when the cluster cannot be read: an empty answer must mean "none
# recorded", never "could not ask", or a new id would replace the real one.
recorded_cluster_id() {
  kubectl -n "$LAYOUT_NAMESPACE" get configmap "$LAYOUT_CONFIGMAP" --ignore-not-found -o jsonpath='{.data.clusterId}' ||
    { echo "cannot read the cluster id from $LAYOUT_NAMESPACE/$LAYOUT_CONFIGMAP" >&2; return 1; }
}
new_cluster_id() {
  local id=${CLUSTER_ID:-$(date -u +%Y%m%d)-$(openssl rand -hex 3)}
  [[ $id =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] ||
    { echo "CLUSTER_ID must be lowercase letters, digits and dashes: $id" >&2; return 1; }
  echo "$id"
}
write_layout() { # layout, cluster id
  kubectl create namespace "$LAYOUT_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl -n "$LAYOUT_NAMESPACE" create configmap "$LAYOUT_CONFIGMAP" --dry-run=client -o yaml \
    --from-literal=layout="$1" --from-literal=clusterId="$2" | kubectl apply -f - >/dev/null
}

# Records the layout and the cluster id; refuses to change either once
# recorded.
record_layout() { # single-node | multi-node
  local recorded id
  recorded=$(kubectl -n "$LAYOUT_NAMESPACE" get configmap "$LAYOUT_CONFIGMAP" --ignore-not-found -o jsonpath='{.data.layout}')
  if [[ -n $recorded && $recorded != "$1" ]]; then
    echo "this cluster was installed as $recorded; it cannot become $1" >&2
    return 1
  fi
  id=$(recorded_cluster_id) || return 1
  if [[ -n $id && -n ${CLUSTER_ID:-} && $id != "$CLUSTER_ID" ]]; then
    echo "this cluster's id is $id; it cannot become $CLUSTER_ID" >&2
    return 1
  fi
  [[ -n $id ]] || id=$(new_cluster_id)
  write_layout "$1" "$id"
}

# Sets LAYOUT and what depends on it: SITE_REPLICAS, how many replicas run
# of what runs once per compute Site, and the default CLUSTER_ISSUER. A
# single-node cluster uses Let's Encrypt's production issuer, since it lives
# longer than one session and staging certificates are not trusted.
load_layout() {
  LAYOUT=$(cluster_layout)
  # A cluster installed before decision 149 gets its id on the first step
  # run again; its Databases then archive into a new, empty folder.
  CLUSTER_ID=$(recorded_cluster_id) || return 1
  if [[ -z $CLUSTER_ID ]]; then
    CLUSTER_ID=$(new_cluster_id)
    write_layout "$LAYOUT" "$CLUSTER_ID"
    echo "recorded the cluster id $CLUSTER_ID" >&2
  fi
  if [[ $LAYOUT == single-node ]]; then
    SITE_REPLICAS=1
    CLUSTER_ISSUER=${CLUSTER_ISSUER:-letsencrypt}
  else
    SITE_REPLICAS=2
    CLUSTER_ISSUER=${CLUSTER_ISSUER:-letsencrypt-staging}
  fi
}

# Prints the DatabaseConfig for LAYOUT (after load_layout):
# database-config.json with the layout, which decides whether a Database
# gets a standby, the cluster id as the backup folder (decision 149), and on a single node k3s's local-path storage instead of
# TopoLVM (decision 112).
database_config() {
  jq --arg layout "$LAYOUT" --arg prefix "$CLUSTER_ID" '(. + {layout: $layout}
    + (if $layout == "single-node" then {storageClass: "local-path"} else {} end))
    | .backup.prefix = $prefix' database-config.json
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
