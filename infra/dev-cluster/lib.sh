# Sourced by the install steps (operators.sh, ingress.sh, garage.sh,
# platform.sh, monitoring.sh) and the two entry scripts. Not run on its own.
#
# The cluster's layout (ARCHITECTURE.md, decision 112) is recorded once by
# install-single-node.sh or install-multi-node.sh in the ConfigMap
# openupstream-system/cluster-layout, so a step run again on its own (e.g.
# platform.sh for CLI_CLIENT_ID) installs the same way as the first time:
#
# - multi-node: nodes in at least three Sites, two or more of them compute
#   Sites, the layout of production;
# - single-node: one node standing in for every Site, one copy of
#   everything, no failover. For development only.
#
# Nothing here names a Site: the nodes' labels say which Sites there are
# (ADR-0007). The node setup sets them when a node joins (k3s
# --node-label); check_sites only reads them.

LAYOUT_NAMESPACE=openupstream-system
LAYOUT_CONFIGMAP=cluster-layout
# Every node carries its Site's id as this label.
ZONE_LABEL=topology.kubernetes.io/zone
# The nodes of a compute Site, which run Databases, Services, Jobs, Traefik
# and the platform's own pods.
COMPUTE_LABEL=openupstream.io/compute-site
# The nodes of the default Home site, one compute Site.
DEFAULT_LABEL=openupstream.io/default-site
# Every node outside the compute Sites carries it, as NoSchedule.
THIRD_SITE_TAINT=openupstream.io/third-site

# Whether a word is in a space-separated list (Site ids have no spaces).
has() { [[ " $1 " == *" $2 "* ]]; } # list, word
# Whether a Site id is a valid label value: at most 63 letters, digits,
# `-`, `_` and `.`, starting and ending with a letter or digit.
valid_site_id() { [[ $1 =~ ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$ ]]; }

# Checks the Sites' node labels (ADR-0007) before record_layout, and
# changes nothing: every node has a Site; within a Site all nodes agree on
# the compute and the default label; exactly one default Site, a compute
# Site. multi-node also needs at least two compute Sites (a Database's
# standby goes to another one), at least three Sites in all (etcd's and
# Garage's quorum), the taint THIRD_SITE_TAINT=true:NoSchedule on every
# node outside the compute Sites and on none inside. single-node needs
# exactly one node, labelled compute and default. Each problem is printed
# with the command that fixes it; prints the Sites when all is well.
check_sites() { # single-node | multi-node
  local nodes problems= sites= compute= default= unzoned name site is_compute is_default tainted total ncompute ndefault count first
  # One line per node: name, Site (- for none), compute, default, tainted.
  nodes=$(kubectl get nodes -o json | jq -r --arg zone "$ZONE_LABEL" --arg compute "$COMPUTE_LABEL" \
    --arg default "$DEFAULT_LABEL" --arg taint "$THIRD_SITE_TAINT" \
    '.items[] | [.metadata.name, (.metadata.labels[$zone] // "-"),
      (.metadata.labels[$compute] == "true"), (.metadata.labels[$default] == "true"),
      any(.spec.taints[]?; .key == $taint and .effect == "NoSchedule")] | map(tostring) | join(" ")') ||
    { echo "cannot read the nodes; is KUBECONFIG right?" >&2; return 1; }
  [[ -n $nodes ]] || { echo "the cluster has no nodes" >&2; return 1; }
  # Bash functions are global: the prefix keeps this one from clashing
  # in the scripts that source this file.
  _check_sites_problem() { problems+="- $1"$'\n'; }

  for name in $(awk '$2 == "-" {print $1}' <<<"$nodes"); do
    _check_sites_problem "node $name has no Site: kubectl label node $name $ZONE_LABEL=<Site id>"
  done
  if [[ $1 == single-node ]]; then
    count=$(wc -l <<<"$nodes" | tr -d ' ')
    if [[ $count -ne 1 ]]; then
      echo "the cluster has $count nodes; install-single-node.sh needs exactly one" \
        "(install-multi-node.sh is for nodes in three or more Sites)" >&2
      return 1
    fi
    read -r name site is_compute is_default _ <<<"$nodes"
    [[ $is_compute == true && $is_default == true ]] ||
      _check_sites_problem "node $name is not labelled as the compute and default Site: kubectl label node $name $COMPUTE_LABEL=true $DEFAULT_LABEL=true"
  fi

  # Per Site: its nodes, how many are compute, how many default.
  while read -r site total ncompute ndefault; do
    [[ -n $site ]] || continue
    sites+=" $site"
    if ((ncompute > 0)); then
      compute+=" $site"
      ((ncompute == total)) ||
        _check_sites_problem "only some nodes of $site are labelled $COMPUTE_LABEL=true: kubectl label nodes -l $ZONE_LABEL=$site $COMPUTE_LABEL=true (or $COMPUTE_LABEL- on all of them)"
    fi
    if ((ndefault > 0)); then
      default+=" $site"
      ((ndefault == total)) ||
        _check_sites_problem "only some nodes of $site are labelled $DEFAULT_LABEL=true: kubectl label nodes -l $ZONE_LABEL=$site $DEFAULT_LABEL=true (or $DEFAULT_LABEL- on all of them)"
    fi
  done <<<"$(awk '$2 != "-" {n[$2]++; if ($3 == "true") c[$2]++; if ($4 == "true") d[$2]++}
    END {for (s in n) print s, n[s], c[s] + 0, d[s] + 0}' <<<"$nodes" | LC_ALL=C sort)"
  sites=${sites# } compute=${compute# } default=${default# }
  first=${compute%% *}

  if [[ $1 == multi-node ]]; then
    [[ $(wc -w <<<"$compute") -ge 2 ]] ||
      _check_sites_problem "multi-node needs at least two compute Sites, for a Database's standby (compute Sites: ${compute:-none}):\
 kubectl label nodes -l $ZONE_LABEL=<Site> $COMPUTE_LABEL=true, and kubectl taint node <name> $THIRD_SITE_TAINT- on each of its nodes that has the taint"
    [[ $(wc -w <<<"$sites") -ge 3 ]] ||
      _check_sites_problem "multi-node needs nodes in at least three Sites, for etcd's and Garage's quorum (Sites: $sites): join a node of another Site"
    while read -r name site _ _ tainted; do
      [[ $site != - ]] || continue
      if has "$compute" "$site"; then
        [[ $tainted == false ]] ||
          _check_sites_problem "node $name is in the compute Site $site but carries the taint $THIRD_SITE_TAINT: kubectl taint node $name $THIRD_SITE_TAINT-"
      elif [[ $tainted == false ]]; then
        _check_sites_problem "node $name is in no compute Site but lacks the taint: kubectl taint node $name $THIRD_SITE_TAINT=true:NoSchedule"
      fi
    done <<<"$nodes"
  fi

  case $(wc -w <<<"$default" | tr -d ' ') in
    0) _check_sites_problem "no default Site: kubectl label nodes -l $ZONE_LABEL=${first:-<compute Site>} $DEFAULT_LABEL=true" ;;
    1) ;;
    *) _check_sites_problem "more than one default Site ($default): keep one, e.g. kubectl label nodes -l $ZONE_LABEL=${default##* } $DEFAULT_LABEL-" ;;
  esac
  for site in $default; do
    has "$compute" "$site" ||
      _check_sites_problem "the default Site $site is no compute Site: kubectl label nodes -l $ZONE_LABEL=$site $DEFAULT_LABEL-, then label a compute Site's nodes $DEFAULT_LABEL=true"
  done

  if [[ -n $problems ]]; then
    printf 'the nodes'"'"' Site labels need fixing (ADR-0007; infra/dev-cluster/README.md, "Sites"):\n%s' "$problems" >&2
    return 1
  fi
  echo "Sites: $sites; compute Sites: $compute; default Site: $default"
}

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
# of what survives a Site failure by running in more than one compute Site
# (min(2, compute Sites), ADR-0007: 2, since multi-node has at least two),
# and the default CLUSTER_ISSUER. A
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
