# Failover test: a whole compute Site down

Proves that a Database keeps taking writes when its primary's Site goes dark
(ARCHITECTURE.md, "Sites and failure handling" and "Postgres"), then moves the
primary back. First done on the dev cluster on 2026-10-17
(`infra/dev-cluster`).

## Before

- The Database is healthy, its primary in the Home site:
  `kubectl -n project-<project id> get cluster db-<database id>`.
- CoreDNS and the CloudNativePG operator have one pod in each compute Site
  (`kubectl get pods -A -o wide | grep -E 'coredns|cnpg-controller'`). Pods
  do not move back on their own after an earlier failure (Open question 11);
  delete the one in the wrong Site and it is recreated in the right one.
- Your kubeconfig does not point at an API server in the Site you switch off.

## Writes during the test

A pod in the other compute Site that writes through the Pooler once a second
and prints the id or the error. A new connection per write, like a
serverless client:

```yaml
apiVersion: v1
kind: Pod
metadata: {name: writer, namespace: project-<project id>}
spec:
  nodeSelector: {topology.kubernetes.io/zone: ovh-lim}
  restartPolicy: Never
  containers:
    - name: writer
      image: ghcr.io/cloudnative-pg/postgresql:17-standard-trixie
      env:
        - {name: PGUSER, valueFrom: {secretKeyRef: {name: db-<database id>-app, key: username}}}
        - {name: PGPASSWORD, valueFrom: {secretKeyRef: {name: db-<database id>-app, key: password}}}
        - {name: PGHOST, value: db-<database id>-pooler}
        - {name: PGDATABASE, value: app}
        - {name: PGCONNECT_TIMEOUT, value: "2"}
      command: [bash, -c]
      args:
        - |
          while true; do
            echo "$(date -u +%T.%N | cut -c1-12) $(psql -XtAqc 'insert into writes (client_at) values (now()) returning id' 2>&1 | head -1)"
            sleep 1
          done
```

It needs `create table writes (id bigserial primary key, client_at
timestamptz not null)` owned by `app`.

## Switch the Site off

Power the node off hard, so it sends nothing (dev cluster:
`hcloud server poweroff oup-dev-hetzner-fsn1`). Record every few seconds the
node's Ready condition and the Cluster's `currentPrimary`, `targetPrimary`
and phase.

## Expected (measured 2026-10-17)

| After | What |
| --- | --- |
| 0 s | last write before the outage |
| ~40 s | node `Unknown`; dead CoreDNS endpoint removed, DNS works again |
| ~65 s | CloudNativePG operator in the other Site holds the leader lease |
| ~85 s | standby promoted |
| ~90 s | writes through the Pooler succeed again |

No acknowledged write may be lost: every id the writer printed before the
outage must be in `writes`. Ids are not contiguous after a promotion
(sequence caching), that is expected.

If writes stop for minutes, compare with the causes found in the first run:
CoreDNS or the operator in the dark Site only, the 300 s default
tolerations, PgBouncer without keepalives (ARCHITECTURE.md, decisions 46 and
50).

## Switch the Site back on

The old primary rejoins as a standby by itself (`pg_rewind`); wait until the
Cluster reports 2 ready instances.

## Fail back to the Home site

A switchover, the same status change `kubectl cnpg promote` makes:

```bash
kubectl -n project-<project id> patch cluster db-<database id> --subresource=status --type merge -p '{"status":{"targetPrimary":"db-<database id>-<instance in the Home site>","targetPrimaryTimestamp":"<now, RFC 3339>","phase":"Switchover in progress","phaseReason":"Switching over to db-<database id>-<instance>"}}'
```

Writes pause for about 15 s. Done when `currentPrimary` is the instance in
the Home site and the phase is `Cluster in healthy state`.
