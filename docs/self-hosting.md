# Running openupstream yourself

What you need, outside this repository, to run openupstream: the tools on
your machine and the accounts, credentials and domains the platform uses.
The hosted service at openupstream.com is set up exactly this way. The
reasons for each choice are in [ARCHITECTURE.md](../ARCHITECTURE.md); the
numbers in brackets are its decisions.

Each section is written when the step was first done for real. Status of
the platform itself: build step 1 (Postgres) works on a development cluster
(`infra/dev-cluster`); there is no production setup yet.

Credentials never go into this repository. The scripts read them from your
machine (`~/.aws/credentials`, `~/.config/openupstream/`, the `hcloud` CLI's
context) and put them into the cluster as Kubernetes Secrets.

## 1. Tools

| Tool | For |
| --- | --- |
| Node.js 22 and npm (`nvm use` reads `.nvmrc`) | building and testing, the scripts in `operators/scripts` |
| Docker (Docker Desktop or Colima) | the control plane's tests, building images locally |
| `hcloud` | creating and deleting the development cluster's VMs |
| `kubectl` | everything on the cluster |
| AWS CLI (`aws`) | the backup bucket (it speaks S3), and SES later |
| `jq`, `curl`, `ssh`, `openssl`, `dig` | the scripts in `infra/dev-cluster` |

On macOS: `brew install hcloud kubectl awscli jq`.

## 2. Container images

GitHub Actions builds the control plane and operators images on every push
and publishes them to the GitHub Container Registry of the repository's
owner (`.github/workflows/images.yml`, #55). The cluster pulls them without
credentials, so the packages must be public:

1. Push once, so that the Images workflow creates both packages.
2. On GitHub, open your organization's (or account's) **Packages**, then
   `control-plane` and `operators`, each: **Package settings → Danger Zone →
   Change visibility → Public**.

In a fork, the images are `ghcr.io/<your owner>/…`; the deploy manifests and
`infra/dev-cluster/platform.sh` still say `openupstream`, so adjust them.

## 3. Hetzner Cloud: the development cluster

The development cluster is three Hetzner Cloud VMs created and deleted per
working session (#33, #52); see [infra/dev-cluster](../infra/dev-cluster/README.md).

1. In the [Hetzner Cloud Console](https://console.hetzner.cloud), create a
   project for it, e.g. `openupstream-dev`.
2. In that project, generate an API token (under **Security → API
   tokens**) with read and write access.
3. On your machine, store it in the `hcloud` CLI (it asks for the token):

   ```bash
   hcloud context create openupstream-dev
   ```

Three `cpx32` VMs cost about €0.20 an hour together; `infra/dev-cluster/down.sh`
deletes everything `up.sh` created.

## 4. Hetzner Object Storage: backups

Database backups go to Hetzner Object Storage in Nuremberg (NBG1), a location
where no Database runs, with credentials separate from the cluster's (#27).

1. In the Hetzner Console, create a **separate project** for backups, e.g.
   `openupstream-backups`, so that a leaked cluster credential cannot touch
   them.
2. In it: **Object Storage → Create bucket**, location **Nuremberg (nbg1)**,
   private. The name must be globally unique; ours is `openupstream-pg-backup`.
3. Generate S3 credentials for that project in the Hetzner Console: an
   access key and a secret key. The secret is shown only once.
4. Store them as the AWS CLI profile `openupstream-backup` in
   `~/.aws/credentials` (keep that file private, `chmod 600`):

   ```ini
   [openupstream-backup]
   aws_access_key_id = <access key>
   aws_secret_access_key = <secret key>
   ```

5. Check that the bucket is reachable:

   ```bash
   aws --profile openupstream-backup --endpoint-url https://nbg1.your-objectstorage.com s3 ls
   ```

6. Put your bucket's name into `infra/dev-cluster/database-config.json`
   (`backup.bucket`).

`infra/dev-cluster/operators.sh` copies the profile into the cluster as the
Secret `openupstream-system/backup-s3`.

## 5. bunny.net: DNS

All of openupstream's DNS zones are on bunny.net DNS, whose health checks
drop a failed Site from the ingress records (#32, #34). cert-manager also
uses it for DNS-01 certificate challenges (#69).

The development cluster gets its own subdomain, delegated to bunny.net, so
each session can point records at its VMs while the parent domain stays
where it is (#70). Ours is `dev.openupstream.com`; the parent domain is
registered and served by domaindiscount24.

1. Create an account at [bunny.net](https://bunny.net).
2. **DNS → Add DNS Zone**: enter the subdomain itself, e.g.
   `dev.openupstream.com`. Leave it empty; the scripts create the records.
   bunny.net's nameservers are `kiki.bunny.net` and `coco.bunny.net`.
3. At the DNS provider of the parent domain, delegate the subdomain with two
   NS records. Do not change the parent domain's own nameservers.

   | Name | Type | Value |
   | --- | --- | --- |
   | `dev` | NS | `kiki.bunny.net.` |
   | `dev` | NS | `coco.bunny.net.` |

   At domaindiscount24: open the domain, **DNS settings → Create new
   subdomain** with `dev`, then **Edit** on the new `dev.<domain>` row and
   enter the two nameservers. Leave the **Whois / Nameserver** tab alone: it
   moves the whole domain.
4. Check the delegation (it can take as long as the parent's NS TTL, a few
   hours at most); both bunny.net nameservers should be listed:

   ```bash
   dig +short NS dev.openupstream.com
   ```

5. **Account Settings → API**: copy the API key into a file only you can
   read. It gives access to the whole bunny.net account, so keep it out of
   shell history and the repository:

   ```bash
   mkdir -p ~/.config/openupstream && touch ~/.config/openupstream/bunny-api-key && chmod 600 ~/.config/openupstream/bunny-api-key
   ```

   Then paste the key into that file with an editor.

The production zones (`openupstream.com` for our own services, #67, and the
customer domain `openupstream.app`, #68) move to bunny.net entirely when the
production servers exist; that part is written then.

## Coming with build step 2

- **Amazon SES** for madAuth's e-mails (#66): an AWS profile allowed to send,
  its EU region and a verified sender.
- **Stripe** for the payment method an Account needs (#65).
- The production DNS zones and public hostnames.
