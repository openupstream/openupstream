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
# (ADR-0007), and label_sites sets the compute and default labels.

LAYOUT_NAMESPACE=openupstream-system
LAYOUT_CONFIGMAP=cluster-layout
# Every node carries its Site's id as this label.
ZONE_LABEL=topology.kubernetes.io/zone
# The nodes of a compute Site, which run Databases, Services, Jobs, Traefik
# and the platform's own pods.
COMPUTE_LABEL=openupstream.io/compute-site
# The nodes of the default Home site, one compute Site.
DEFAULT_LABEL=openupstream.io/default-site
DESCRIPTION_ANNOTATION=openupstream.io/site-description
# Every node outside the compute Sites carries it, as NoSchedule.
THIRD_SITE_TAINT=openupstream.io/third-site

# Whether a word is in a space-separated list (Site ids have no spaces).
has() { [[ " $1 " == *" $2 "* ]]; } # list, word
# Whether a Site id is a valid label value: at most 63 letters, digits,
# `-`, `_` and `.`, starting and ending with a letter or digit.
valid_site_id() { [[ $1 =~ ^[A-Za-z0-9]([A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$ ]]; }
# Trims leading and trailing whitespace.
trim() { local s=$1; s=${s#"${s%%[![:space:]]*}"}; echo "${s%"${s##*[![:space:]]}"}"; }

# Sets and checks the Sites' node labels (ADR-0007), before record_layout;
# changes nothing when a check fails:
#
# - COMPUTE_SITES, space-separated Site ids: their nodes get the compute
#   label, every other node loses it. Unset, the Sites with a node already
#   labelled stay the compute Sites; with none labelled it fails.
# - DEFAULT_SITE, a compute Site: its nodes get the default label, every
#   other node loses it. Unset, the labelled default stays while it is a
#   compute Site, else the first compute Site by name becomes it.
# - SITE_DESCRIPTIONS, optional, `id=text;id=text`: the annotation on every
#   node of that Site; `id=` removes it. Unset, descriptions stay as they
#   are.
#
# multi-node needs a Site on every node, at least two compute Sites (a
# Database's standby goes to another one), at least three Sites in all
# (etcd's and Garage's quorum), the taint THIRD_SITE_TAINT=true:NoSchedule
# on every other node and on no compute node. single-node needs exactly one
# node with a Site, which becomes the compute and default Site.
label_sites() { # single-node | multi-node
  local nodes name site compute default sites unzoned count entry text found
  local is_compute is_default tainted current args entries=() untainted= tainted_compute=
  # One line per node: name, Site (- for none), compute, default, tainted,
  # description.
  nodes=$(kubectl get nodes -o json | jq -r --arg zone "$ZONE_LABEL" --arg compute "$COMPUTE_LABEL" \
    --arg default "$DEFAULT_LABEL" --arg taint "$THIRD_SITE_TAINT" --arg description "$DESCRIPTION_ANNOTATION" \
    '.items[] | [.metadata.name, (.metadata.labels[$zone] // "-"),
      (.metadata.labels[$compute] == "true"), (.metadata.labels[$default] == "true"),
      any(.spec.taints[]?; .key == $taint and .effect == "NoSchedule"),
      ((.metadata.annotations // {})[$description] // "" | gsub("\\s+"; " "))] | map(tostring) | join(" ")') ||
    { echo "cannot read the nodes; is KUBECONFIG right?" >&2; return 1; }
  [[ -n $nodes ]] || { echo "the cluster has no nodes" >&2; return 1; }
  count=$(wc -l <<<"$nodes" | tr -d ' ')
  sites=$(awk '$2 != "-" {print $2}' <<<"$nodes" | LC_ALL=C sort -u | xargs)
  unzoned=$(awk '$2 == "-" {print $1}' <<<"$nodes" | xargs)
  [[ -z $unzoned ]] ||
    { echo "no $ZONE_LABEL on the node(s) $unzoned: every node needs its Site's id as that label" >&2; return 1; }

  if [[ $1 == single-node ]]; then
    if [[ $count -ne 1 ]]; then
      echo "the cluster has $count nodes; install-single-node.sh needs exactly one" \
        "(install-multi-node.sh is for nodes in three or more Sites)" >&2
      return 1
    fi
    for entry in "COMPUTE_SITES=${COMPUTE_SITES:-}" "DEFAULT_SITE=${DEFAULT_SITE:-}"; do
      [[ -z ${entry#*=} || ${entry#*=} == "$sites" ]] ||
        { echo "single-node: ${entry%%=*} can only be the node's Site $sites" >&2; return 1; }
    done
    compute=$sites default=$sites
  else
    if [[ -n ${COMPUTE_SITES:-} ]]; then
      compute=$(tr -s ' \t' '\n' <<<"$COMPUTE_SITES" | grep -v '^$' | LC_ALL=C sort -u | xargs)
      for site in $compute; do
        has "$sites" "$site" || { echo "COMPUTE_SITES names $site, but no node has $ZONE_LABEL=$site (Sites: $sites)" >&2; return 1; }
      done
    else
      compute=$(awk '$3 == "true" {print $2}' <<<"$nodes" | LC_ALL=C sort -u | xargs)
      [[ -n $compute ]] ||
        { echo "no node is labelled $COMPUTE_LABEL=true; set COMPUTE_SITES to the compute Sites' ids (Sites: $sites)," \
          "e.g. COMPUTE_SITES=\"${sites% *}\"" >&2; return 1; }
    fi
    [[ $(wc -w <<<"$compute") -ge 2 ]] ||
      { echo "multi-node needs at least two compute Sites, for a Database's standby; compute Sites: $compute" >&2; return 1; }
    [[ $(wc -w <<<"$sites") -ge 3 ]] ||
      { echo "multi-node needs nodes in at least three Sites, for etcd's and Garage's quorum; Sites: $sites" >&2; return 1; }
    while read -r name site _ _ tainted _; do
      if has "$compute" "$site"; then
        [[ $tainted == false ]] || tainted_compute+=" $name"
      else
        [[ $tainted == true ]] || untainted+=" $name"
      fi
    done <<<"$nodes"
    [[ -z $untainted ]] ||
      { echo "the node(s)$untainted are in no compute Site but lack the taint $THIRD_SITE_TAINT=true:NoSchedule;" \
        "kubectl taint node <name> $THIRD_SITE_TAINT=true:NoSchedule, or add their Site to COMPUTE_SITES" >&2; return 1; }
    [[ -z $tainted_compute ]] ||
      { echo "the node(s)$tainted_compute are in a compute Site but carry the taint $THIRD_SITE_TAINT;" \
        "kubectl taint node <name> $THIRD_SITE_TAINT-" >&2; return 1; }
    if [[ -n ${DEFAULT_SITE:-} ]]; then
      has "$compute" "$DEFAULT_SITE" ||
        { echo "DEFAULT_SITE $DEFAULT_SITE is not a compute Site ($compute)" >&2; return 1; }
      default=$DEFAULT_SITE
    else
      default=
      for site in $(awk '$4 == "true" {print $2}' <<<"$nodes" | LC_ALL=C sort -u); do
        if has "$compute" "$site"; then default=$site; break; fi
      done
      [[ -n $default ]] || default=${compute%% *}
    fi
  fi

  if [[ -n ${SITE_DESCRIPTIONS+set} ]]; then
    IFS=';' read -r -a entries <<<"$SITE_DESCRIPTIONS"
    for entry in ${entries[@]+"${entries[@]}"}; do
      [[ -n $(trim "$entry") ]] || continue
      [[ $entry == *=* ]] || { echo "SITE_DESCRIPTIONS: '$entry' is not id=text" >&2; return 1; }
      site=$(trim "${entry%%=*}")
      has "$sites" "$site" || { echo "SITE_DESCRIPTIONS names $site, but no node has $ZONE_LABEL=$site" >&2; return 1; }
    done
  fi

  # Every check passed: change only what differs.
  while read -r name site is_compute is_default _ current; do
    args=()
    if has "$compute" "$site"; then
      [[ $is_compute == true ]] || args+=("$COMPUTE_LABEL=true")
    elif [[ $is_compute == true ]]; then
      args+=("$COMPUTE_LABEL-")
    fi
    if [[ $site == "$default" ]]; then
      [[ $is_default == true ]] || args+=("$DEFAULT_LABEL=true")
    elif [[ $is_default == true ]]; then
      args+=("$DEFAULT_LABEL-")
    fi
    if [[ ${#args[@]} -gt 0 ]]; then
      kubectl label node "$name" --overwrite "${args[@]}" >/dev/null </dev/null
    fi
    found= text=
    for entry in ${entries[@]+"${entries[@]}"}; do
      if [[ $entry == *=* && $(trim "${entry%%=*}") == "$site" ]]; then found=1 text=$(trim "${entry#*=}"); fi
    done
    if [[ -n $found && $text != "$current" ]]; then
      if [[ -n $text ]]; then
        kubectl annotate node "$name" --overwrite "$DESCRIPTION_ANNOTATION=$text" >/dev/null </dev/null
      else
        kubectl annotate node "$name" "$DESCRIPTION_ANNOTATION-" >/dev/null </dev/null
      fi
    fi
  done <<<"$nodes"
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
