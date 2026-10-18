# dev-cluster

A throwaway k3s cluster with the three Sites' layout, for one working
session (ARCHITECTURE.md, decisions 33 and 52). Three Hetzner Cloud VMs
stand in for the Sites; the nodes carry the real Site names:

| Node | Location | Stands in for |
| --- | --- | --- |
| `oup-dev-hetzner-fsn1` | fsn1 | `hetzner-fsn1`, compute Site |
| `oup-dev-ovh-lim` | hel1 | `ovh-lim`, compute Site (Hetzner Cloud has no Limburg) |
| `oup-dev-netcup-nbg` | nbg1 | `netcup-nbg`, third Site, tainted `openupstream.io/third-site` |

Three `cpx32` cost about €0.20 an hour together (gross, October 2026). Storage is k3s's
local-path provisioner, not TopoLVM.

## Use

Needs `hcloud` with a context for the dev Cloud project, `kubectl`, `jq`, Node, and the
AWS CLI profile `openupstream-backup` with the S3 keys of the backup project
on Hetzner Object Storage.

```bash
./up.sh
```

```bash
export KUBECONFIG=$PWD/.state/kubeconfig
```

```bash
./operators.sh
```

`up.sh` creates the VMs, a firewall (SSH and the Kubernetes API only from
your IP, everything between the nodes) and k3s with embedded etcd and
flannel `wireguard-native`. `operators.sh` installs cert-manager,
CloudNativePG and the Barman Cloud Plugin at the versions in
`operators/crds`, spreads CoreDNS and the CloudNativePG operator over the
compute Sites, and creates the backup credentials Secret in
`openupstream-system`. Then:

```bash
./platform.sh
```

It creates the platform Project's Databases (the control plane's and
madAuth's), runs madAuth with its sidecar, the control plane and the
Databases operator, with the
GHCR images of the current commit pinned by digest (`IMAGE_TAG` to choose
others; the commit must be pushed and its Images workflow done). The
DatabaseConfig is `database-config.json`.

madAuth's public URL on the dev cluster is `http://localhost:8787`: forward
it, and the API, from the platform Project's namespace:

```bash
kubectl -n project-00000000-0000-4000-8000-000000000002 port-forward svc/madauth 8787 &
kubectl -n project-00000000-0000-4000-8000-000000000002 port-forward svc/control-plane 8080 &
```

Sign up with e-mail and password through madAuth's HTTP API (`Origin` must
be the allowed origin), take the code from the sidecar's log, and confirm
it; the session cookie `madauth_session` is a token for the API:

```bash
curl -X POST -H 'Origin: http://localhost:8787' -H 'content-type: application/json' http://localhost:8787/auth/password/signup -d '{"email":"you@example.com","password":"a long passphrase","redirectTo":"http://localhost:8787/"}'
```

```bash
kubectl -n project-00000000-0000-4000-8000-000000000002 logs deploy/madauth -c sidecar
```

```bash
curl -c jar -X POST -H 'Origin: http://localhost:8787' -H 'content-type: application/json' http://localhost:8787/auth/email/verify -d '{"email":"you@example.com","code":"<code>"}'
```

Then `POST /v1/accounts` with that token creates your Account; API keys
come from `POST /auth/api-keys/create` with the same cookie (scopes
`openupstream:read` or `openupstream:write`).

Without the control plane, one pass from this machine, from `operators/`:

```bash
npx tsx scripts/reconcile-databases.ts rows.json config.json --dry-run
```

where `rows.json` is `[{ "project": …, "database": … }]` and `config.json` a
`DatabaseConfig` (storage class `local-path`).

The kubeconfig points at the `hetzner-fsn1` node. Before switching that Site
off, point it at another node's IP (all three serve the API).

When done:

```bash
./down.sh
```

It deletes the VMs, the firewall, the SSH key and `.state/`. Backups the
session wrote stay in the bucket.
