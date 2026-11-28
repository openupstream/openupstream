# Node maintenance: one node out and back

**Draft, not yet run.** Written before the first run (decision 160); fill
in what the first run finds, with its date, and remove this note.

Takes one node out of service, does the work and puts it back: a k3s
upgrade, operating system updates and a reboot, a hardware repair. The
other nodes carry the load meanwhile (ARCHITECTURE.md, "Sites and failure
handling"). Nodes are never reinstalled for this; a new operating system
release is the exception, and even then it is done one node at a time like
this.

What customers notice, if the steps are followed:

| What runs on the node | What happens |
| --- | --- |
| A Service with two or more replicas | nothing; its PodDisruptionBudget lets one pod go at a time |
| A Service with one replica | nothing; step 4 starts its replacement before the old pod stops |
| A Database's primary | a switchover to the standby in the other Site, clients wait a few seconds |
| A Database's standby | the Database runs without a standby until the node is back: its volume is on the node |
| Traefik | nothing, once step 2 took the node out of DNS |
| Garage | nothing; every object has copies in the two other Sites |

Today each Site has one node, so taking a node out takes its Site out: a
planned version of the failover test, with the moves done before instead
of after. The node of the non-compute Site has no DNS records, Services or
Databases: skip steps 2, 4 and 8 there.

## Rules

- **One node at a time.** Every node is a k3s server with an etcd member;
  three keep quorum with one out, not with two.
- Do not start while another node is down or a Database is not healthy.
- A single-node installation cannot do this without downtime: everything
  stops while k3s restarts.

## 1. Before

- All nodes `Ready`: `kubectl get nodes`.
- Every Database healthy, with 2 ready instances:
  `kubectl get clusters.postgresql.cnpg.io -A`.
- Every PodDisruptionBudget allows a disruption:
  `kubectl get pdb -A` (`ALLOWED DISRUPTIONS` at least 1). One at 0 blocks
  the drain later: find out why first (a pod not ready, a replacement still
  starting).
- A base backup of every Database from the last day:
  `kubectl get backups -A`.
- Your kubeconfig does not point at this node's API server.

## 2. Out of DNS

Each compute node has its own A records at bunny.net (`infra/dev-cluster/dns.sh`,
TTL 60 s). Delete this node's records, in the bunny.net dashboard or with its
API, and wait two minutes, so browsers stop sending requests to the node's
Traefik. Otherwise they wait for the health check to drop the record (Open
question 2).

To fill in at the first run: the exact command. `dns.sh` writes a record
for every compute node, cordoned or not, so running it now would put the
record back.

## 3. Cordon

```bash
kubectl cordon <node>
```

Nothing new starts on the node from here on.

## 4. Start replacements for single-replica Services

A drain stops a Service's only pod before its replacement is ready. A
restart of its Deployment does it the other way round (maxSurge 1), and
since the node is cordoned the new pod starts elsewhere:

```bash
kubectl get pods -A -l openupstream.io/component=services --field-selector spec.nodeName=<node> \
  -o jsonpath='{range .items[*]}{.metadata.namespace} {.metadata.labels.openupstream\.io/service-id}{"\n"}{end}' |
  sort -u | while read -r ns id; do
    replicas=$(kubectl -n "$ns" get deployment "svc-$id" -o jsonpath='{.spec.replicas}')
    [[ $replicas == 1 ]] && kubectl -n "$ns" rollout restart deployment "svc-$id"
  done
```

Wait until these rollouts are done (`kubectl -n <ns> rollout status
deployment svc-<id>`). A Service set to stop first (decision 158) gets no
replacement: it is down for its restart, as on every deploy.

## 5. Drain

```bash
kubectl drain <node> --ignore-daemonsets --delete-emptydir-data --timeout=20m
```

- CloudNativePG switches a primary on this node over to its standby before
  letting the pod go (its own PodDisruptionBudgets). Watch it with
  `kubectl get clusters.postgresql.cnpg.io -A`.
- The standbys on this node, and Loki's and Prometheus's pods with local
  volumes, stay `Pending` until the node is back.
- If the drain hangs, `kubectl get pdb -A` shows which budget is at 0.

## 6. The work

- **k3s upgrade:** one minor version at a time, every node on the new
  version before the next minor. Replace the binary with the release's
  `k3s` and check it against the release's `sha256sum-amd64.txt`, then
  `systemctl restart k3s`. The flags stay in the systemd unit.
- **Operating system:** `apt-get update && apt-get upgrade`, then reboot.
- **gVisor:** `infra/gvisor/install.sh` runs before k3s starts (decision 90);
  a new pinned version is installed the same way.

To fill in at the first run: how long each took, and anything the node
needed afterwards.

## 7. Back

```bash
kubectl uncordon <node>
```

- The node is `Ready`, and its standbys have caught up: every Database has 2
  ready instances again.
- Put the node's records back into DNS: `infra/dev-cluster/dns.sh`.

## 8. Primaries back to their Home site

A switchover in step 5 left primaries in the other Site, and nothing moves
them back by itself (Open question 11). Fail each one back as in
[failover-test.md](failover-test.md#fail-back-to-the-home-site): pause the
Pooler, switch over, then resume it.

Pods of other Deployments do not move back either; delete the ones in the
wrong Site and they are recreated in the right one, as in the failover
test's "Before".

## After

Next node, starting again at step 1. When the last one is done, update
this runbook with what the run found.
