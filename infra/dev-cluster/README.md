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

Needs `hcloud` with a context for the dev Cloud project, `kubectl`, `helm`,
`jq`, Node, the AWS CLI profiles `openupstream-backup` (backups) and
`openupstream-ses` (madAuth's e-mails), the bunny.net API key in
`~/.config/openupstream/bunny-api-key` and the zones `dev.openupstream.com`
and `dev.openupstream.app` delegated to bunny.net;
[docs/self-hosting.md](../../docs/self-hosting.md) says how to set them up.

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
your IP, HTTP and HTTPS from everywhere, everything between the nodes),
gVisor on the two compute nodes (`infra/gvisor`), and
k3s with embedded etcd and
flannel `wireguard-native`, then the RuntimeClass `gvisor`. `operators.sh` installs cert-manager, whose
Certificates own their Secrets (so a custom domain's key goes with its
Certificate), CloudNativePG and the Barman Cloud Plugin at the versions in
`operators/crds`, spreads CoreDNS and the CloudNativePG operator over the
compute Sites, and creates the backup credentials Secret in
`openupstream-system`. Then:

```bash
./ingress.sh
```

It installs cert-manager's DNS-01 webhook for bunny.net, the Let's Encrypt
issuers and Traefik on both compute nodes, and points `dev.openupstream.com`
and `api.dev.openupstream.com` at both nodes as health-checked bunny.net
records (`dns.sh`). Then:

```bash
./garage.sh
```

It runs Garage with one node per Site (`infra/garage`), generates its RPC
secret and admin token once (the token also goes to the platform Project's
namespace for the control plane), assigns the layout (a node's zone is its
Site, `GARAGE_CAPACITY` each, 20 GB by default) and serves the S3 API at
`https://<bucket>.s3.dev.openupstream.app`, with a wildcard certificate.
It also makes `*.dev.openupstream.app` Traefik's default certificate, for
every Project's default hostname, and points `*` and `*.s3` at both compute
nodes. Then:

```bash
./platform.sh
```

It creates the platform Project's Databases (the control plane's and
madAuth's), runs madAuth with its sidecar, the control plane, the public
routes with their certificate (Let's Encrypt staging: clients need `-k`)
and the Databases, Routes and Services operators, with the GHCR images of the current commit
pinned by digest (`IMAGE_TAG` to choose others; the commit must be pushed
and its Images workflow done). The DatabaseConfig is `database-config.json`.
madAuth sends real e-mails through SES; `MAIL=log ./platform.sh` writes
them to the sidecar's log instead. To try the payment-method gate without a
billing service, set `NEW_ACCOUNT_HOLDS=payment-method` and
`BILLING_CALLERS` to a ServiceAccount you lift Holds with (control-plane
README, "Internal API").

A custom domain (control-plane README) needs a hostname outside both dev
zones, which are reserved; `test.openupstream.com` is a third zone on
bunny.net for that, empty between sessions. Claim e.g.
`shop.test.openupstream.com`, publish its TXT record there, verify, point a
CNAME at `ingress.dev.openupstream.app`, then add a Route. The Routes
operator then requests its certificate through HTTP-01 from Let's Encrypt
staging. Delete the two records afterwards: `down.sh` does not touch that
zone.

madAuth is at `https://dev.openupstream.com/auth`, the API at
`https://api.dev.openupstream.com`. Sign up with e-mail and password
through madAuth's HTTP API (`Origin` must be the allowed origin), and
confirm with the code from the e-mail; the session cookie
`madauth_session` is a token for the API:

```bash
curl -k -X POST -H 'Origin: https://dev.openupstream.com' -H 'content-type: application/json' https://dev.openupstream.com/auth/password/signup -d '{"email":"you@example.com","password":"a long passphrase","redirectTo":"https://dev.openupstream.com/"}'
```

```bash
curl -k -c jar -X POST -H 'Origin: https://dev.openupstream.com' -H 'content-type: application/json' https://dev.openupstream.com/auth/email/verify -d '{"email":"you@example.com","code":"<code>"}'
```

Then `POST https://api.dev.openupstream.com/v1/accounts` with that token
creates your Account; API keys come from `POST /auth/api-keys/create` with
the same cookie (scopes `openupstream:read` or `openupstream:write`).

For `oup login`, run `platform.sh` with `INITIAL_ADMIN_EMAIL` set, sign up
with that address as above, register the CLI with
`CURL_OPTIONS=-k ../madauth/register-cli.sh https://dev.openupstream.com`,
and run `platform.sh` again with the printed `CLI_CLIENT_ID` (and
`INITIAL_ADMIN_EMAIL` still set); it rolls out the control plane and
madAuth whenever their ConfigMap changed. Until the
approval page exists, approve a code with the session cookie:
`POST /auth/device/lookup` and then `POST /auth/device/approve`, each with
`{"code": "<code>"}`.

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

It deletes the DNS records in both zones, the VMs, the firewall, the SSH
key and `.state/`. Backups the session wrote stay in the bucket; Buckets
lived on the VMs and are gone with them.
