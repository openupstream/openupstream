# dev-cluster

Installs the platform onto a k3s cluster for development, in one of two
layouts (ARCHITECTURE.md, "Dev clusters"; decision 112,
[ADR-0004](../../docs/adr/0004-single-node-dev-cluster.md)):

| Layout | Nodes | For | The cluster comes from |
| --- | --- | --- | --- |
| `multi-node` | one per Site, carrying the Site names | everything, failover included; the layout of production | [`infra/dev-cluster-hetzner`](../dev-cluster-hetzner/README.md): three Hetzner Cloud VMs per working session |
| `single-node` | one, standing in for every Site | development on one machine; one copy of everything, no failover | `k3s-single-node.sh`: any x86_64 Linux machine you can reach over SSH |

`install-multi-node.sh` and `install-single-node.sh` record the layout in
the ConfigMap `openupstream-system/cluster-layout` and then run the steps
below in order. Each step reads the layout from there, so one may be run
again on its own and installs the same way; the two scripts refuse a
cluster whose nodes do not match (a multi-node cluster needs a node in each
of `hetzner-fsn1`, `ovh-lim` and `netcup-nbg`, a single-node one exactly
one node), and a recorded layout never changes. The Databases' volumes come
from TopoLVM with one node per Site (decision 109) and from k3s's
local-path provisioner on a single node (decision 112).

`scripts.test.mjs` tests the scripts' own logic with stubbed `kubectl` and
`curl` (`npm run test:infra`, part of `npm test`).

Both need `kubectl`, `helm`, `jq`, Node, the AWS CLI profiles
`openupstream-backup` (backups) and `openupstream-ses` (madAuth's e-mails,
or `MAIL=log`), the bunny.net API key in
`~/.config/openupstream/bunny-api-key`, and DNS zones on bunny.net for the
domains; [docs/self-hosting.md](../../docs/self-hosting.md) says how to set
them up.

## A single node

For development only: losing the node loses every Database, Bucket and
Service on it, and only the Databases' backups survive. Databases are
stored with k3s's local-path provisioner on the root filesystem, not
TopoLVM: their sizes are not reserved, so one can fill the disk, the API
accepts any size unchecked, growing a Database's storage never completes
(local-path cannot expand a volume), and storage does not grow by itself
(decision 111): `platform.sh` leaves the control plane without
Prometheus there, so it records no usage either (metering, decision 114).
The node carries
the label of the compute Site `hetzner-fsn1`; a Database or Service with
the Home site `ovh-lim` runs there as well.

```bash
./k3s-single-node.sh root@192.168.1.50
```

It installs our AppArmor profile for containers (`infra/apparmor`,
needed on Ubuntu 26.04, decision 113), gVisor and then k3s on that machine
over SSH (as root, or as a
user with passwordless sudo; ports 80, 443 and 6443 must be free), labels
the node, applies the RuntimeClass `gvisor` and writes the kubeconfig to
`.state/kubeconfig`. Run again, it installs nothing on a machine that
already has k3s and only fetches the kubeconfig, since both installers
restart k3s (`REINSTALL=1` to install again, e.g. for a new
`K3S_VERSION`). The kubeconfig names the host that ssh resolves the target
to (`HOST` to override).

For a machine in a Tailscale network, reached only from there, give k3s the
machine's Tailscale address as its ExternalIP, so DNS points at that
instead of the home network's address:

```bash
NODE_ADDRESS=$(ssh root@minisforum tailscale ip -4) ./k3s-single-node.sh root@minisforum
```

The names then resolve everywhere but lead to the node only from devices in
the tailnet. Customer containers cannot reach the tailnet: the egress
policies leave out `100.64.0.0/10` and `fc00::/7` and allow the node's own
addresses on 80 and 443 only (decision 105). A machine that already runs k3s can be used as it is
if gVisor was installed before k3s first started (`infra/gvisor`) and the
node carries the labels `topology.kubernetes.io/zone=hetzner-fsn1` and
`openupstream.io/gvisor=true`.

```bash
export KUBECONFIG=$PWD/.state/kubeconfig
```

```bash
PLATFORM_DOMAIN=home.example.com CUSTOMER_DOMAIN=home.example.app ./install-single-node.sh
```

Both domains are required (there are no defaults, so a single node never
takes over the Hetzner dev cluster's zones) and must be set again whenever
a step runs on its own. Each is a bunny.net zone or a name inside one,
e.g. `home.dev.example.com` in the zone `dev.example.com`. `dns.sh` points
them at the node's own address as Kubernetes reports it: in a home network
a private address, which resolves everywhere but leads to the node only
inside that network; nothing needs to be open from the internet.
Certificates come from Let's Encrypt (production, `CLUSTER_ISSUER` to
change it) through the DNS-01 challenge, which needs no inbound
connection. Give the machine a fixed address in the router, and if the
router has DNS rebinding protection (a Fritz!Box, for example), add both
domains as exceptions there, or it drops the answers. Custom domains get no
certificate on such a cluster: their HTTP-01 challenge must reach port 80
from the internet.

## One node per Site

```bash
../dev-cluster-hetzner/up.sh
```

```bash
export KUBECONFIG=$PWD/../dev-cluster-hetzner/.state/kubeconfig
```

```bash
./install-multi-node.sh
```

`PLATFORM_DOMAIN` and `CUSTOMER_DOMAIN` default to `dev.openupstream.com`
and `dev.openupstream.app`, `CLUSTER_ISSUER` to Let's Encrypt staging.

## The steps

`operators.sh` installs cert-manager, whose
Certificates own their Secrets (so a custom domain's key goes with its
Certificate), TopoLVM on the compute nodes with one node per Site
(`infra/topolvm`, StorageClass `topolvm-provisioner`, which
`database-config.json` names; a single node uses `local-path` instead),
CloudNativePG
and the Barman Cloud Plugin at the versions in
`operators/crds`, spreads CoreDNS and the CloudNativePG operator over the
compute Sites (once each on a single node), and creates the backup
credentials Secret in `openupstream-system`.

`ingress.sh` installs cert-manager's DNS-01 webhook for bunny.net, the
Let's Encrypt issuers and Traefik on the compute nodes, and points
`PLATFORM_DOMAIN` at them as a bunny.net record
(`dns.sh`), health-checked when there are two to choose from.

`garage.sh` runs Garage with one node per Site, or one node with one copy
(`infra/garage`), generates its RPC
secret and admin token once (the token also goes to the platform Project's
namespace for the control plane), assigns the layout (a node's zone is its
Site, `GARAGE_CAPACITY` each, 20 GB by default) and serves the S3 API at
`https://<bucket>.s3.CUSTOMER_DOMAIN`, with a wildcard certificate.
It also makes `*.CUSTOMER_DOMAIN` Traefik's default certificate, for
every Project's default hostname, and points `*` and `*.s3` at the compute
nodes. On the Hetzner dev cluster both certificates come from Let's Encrypt
staging, which a Service
reaching a Bucket does not trust (`unable to get local issuer
certificate`); to run one, as the `spa-api` demo app does, use
`CLUSTER_ISSUER=letsencrypt ./garage.sh`, which may run again on a
running cluster. Let's Encrypt issues the same names at most five times a
week. On 2026-11-10 every DNS-01 challenge failed in both zones for an
afternoon with NXDOMAIN for the TXT record, although both bunny.net
nameservers (IPv4 and IPv6, any letter case) and the public resolvers
served it; on 2026-11-15 the same setup issued at once, so the cause was
outside this repository (Let's Encrypt was rolling out more validation
perspectives then). If it happens again, `garage.sh` and `platform.sh`
stop at their certificate wait, after everything but the operators that
`platform.sh` installs last; Traefik serves its default certificate
meanwhile, so the API works with `-k`.

`platform.sh` creates the platform Project's Databases (the control plane's and
madAuth's), runs madAuth with its sidecar, the control plane (once each on
a single node), the public
routes with their certificate (with Let's Encrypt staging clients need `-k`)
and the Databases, Routes and Services operators, with the GHCR images of the current commit
pinned by digest (`IMAGE_TAG` to choose others; the commit must be pushed
and its Images workflow done). The DatabaseConfig is `database-config.json`,
with the cluster's layout added.
madAuth sends real e-mails through SES; `MAIL=log ./platform.sh` writes
them to the sidecar's log instead. To try the payment-method gate without a
billing service, set `NEW_ACCOUNT_HOLDS=payment-method` and
`BILLING_CALLERS` to a ServiceAccount you lift Holds with (control-plane
README, "Internal API"). To close sign-up as the hosted service does, with
the waitlist at `https://dev.openupstream.com`, set `SIGNUP=closed`,
`IMPRINT_FILE` to a text file with an Impressum, and `SIGNUP_ALLOW` to your
own address, so you can still create users (docs/self-hosting.md, "Sign-up
and the waitlist").

For the platform's monitoring (docs/self-hosting.md, section 10), with
the healthchecks.io ping URL in
`~/.config/openupstream/healthchecks-ping-url-dev`:

```bash
ALERT_EMAIL=you@example.com ./monitoring.sh
```

It installs kube-prometheus-stack (Prometheus and Alertmanager once per
compute Site, Grafana), the scrape targets and alert rules of
`infra/monitoring`, and Loki with Alloy, Loki's data in a Garage bucket of
its own. On a single node Prometheus, Alertmanager and Loki run once, Loki
with one copy. `DatabaseWalNotArchived` fires for the
platform's Databases, whose backups do not work on a dev cluster (see below), and
mails the address once a while. On the Hetzner dev cluster the kubeconfig
points at hetzner-fsn1's
API server: to watch the cluster with that node switched off, use a copy
with another node's address as `server`.

A custom domain (control-plane README) needs a hostname outside both dev
zones, which are reserved; `test.openupstream.com` is a third zone on
bunny.net for that, empty between sessions. Claim e.g.
`shop.test.openupstream.com`, publish its TXT record there, verify, point a
CNAME at `ingress.dev.openupstream.app`, then add a Route. The Routes
operator then requests its certificate through HTTP-01 from Let's Encrypt
staging. Delete the two records afterwards:
`../dev-cluster-hetzner/down.sh` does not touch that zone. This needs the
multi-node cluster: HTTP-01 must reach port 80 from the internet.

madAuth is at `https://PLATFORM_DOMAIN/auth`, the API at
`https://PLATFORM_DOMAIN/api`; the examples use the Hetzner dev cluster's
`dev.openupstream.com` (drop `-k` with a production certificate). Sign up with e-mail and password
through madAuth's HTTP API (`Origin` must be the allowed origin), and
confirm with the code from the e-mail; the session cookie
`madauth_session` is a token for the API:

```bash
curl -k -X POST -H 'Origin: https://dev.openupstream.com' -H 'content-type: application/json' https://dev.openupstream.com/auth/password/signup -d '{"email":"you@example.com","password":"a long passphrase","redirectTo":"https://dev.openupstream.com/"}'
```

```bash
curl -k -c jar -X POST -H 'Origin: https://dev.openupstream.com' -H 'content-type: application/json' https://dev.openupstream.com/auth/email/verify -d '{"email":"you@example.com","code":"<code>"}'
```

Then `POST https://dev.openupstream.com/api/v1/accounts` with that token
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
`DatabaseConfig` (storage class `topolvm-provisioner`, or `local-path` on a
single node; `layout` `single-node` for one instance per Database).

The platform Project's Databases have the same ids on every dev cluster,
so their WAL goes to the same path in the backup bucket each time and
archiving fails with `Expected empty archive` (the Cluster's
`ContinuousArchiving` is `False`). Their backups do not work on a dev
cluster, and after a Site failover the old primary cannot rejoin until its
pod and PVC are deleted, after which CloudNativePG clones a new standby.
Customer Databases get new ids and are not affected.

When done with the Hetzner dev cluster, `../dev-cluster-hetzner/down.sh`
deletes it (its README). A single node stays until you remove it:
`/usr/local/bin/k3s-uninstall.sh` on the machine deletes k3s and every
volume; remove its DNS records with `DNS_DOMAIN=<domain> ./dns.sh
--delete` for `PLATFORM_DOMAIN` and, with `DNS_NAMES='* *.s3'`, for
`CUSTOMER_DOMAIN`.
