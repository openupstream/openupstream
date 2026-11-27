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
| Node.js 24 and npm (`nvm use` reads `.nvmrc`) | building and testing, the scripts in `operators/scripts` |
| Docker (Docker Desktop or Colima) | the control plane's tests, building images locally |
| `hcloud` | creating and deleting the Hetzner dev cluster's VMs (not needed for a single node) |
| `incus` (the client) | creating the Incus dev cluster's VMs from your machine (not needed otherwise) |
| `kubectl` | everything on the cluster |
| AWS CLI (`aws`) | the backup bucket (it speaks S3), and SES later |
| `helm` | the Helm releases on the cluster (Traefik, monitoring) |
| `jq`, `curl`, `ssh`, `openssl` | the scripts in `infra/dev-cluster`, `infra/dev-cluster-hetzner` and `infra/dev-cluster-incus` |
| `dig` | checking DNS delegations (section 5) |

On macOS: `brew install hcloud kubectl helm awscli jq`.

Then install and build the repository; the dev-cluster scripts run code
from it (`operators/scripts`, and libraries from `node_modules`). Do it
again after switching branches or pulling: a stale build stops
`platform.sh` (e.g. an SDK export the operators' scripts import is
missing).

```bash
npm ci && npm run build
```

## 2. Container images

GitHub Actions builds the control plane, operators and dashboard images, and the demo
apps' (`example-notes` …, decision 99), on every push and publishes them to the GitHub Container Registry of the repository's
owner (`.github/workflows/images.yml`, #55). The cluster pulls them without
credentials, so the packages must be public:

1. Push once, so that the Images workflow creates the packages.
2. Check each one without credentials: `200` is public, anything else is
   not. GitHub documents a new package as private, yet `example-worker` here
   came up public with nothing done by hand (2026-11-07), so check rather
   than assume. Set `owner` to your own in a fork, and list every image of
   the matrix in `.github/workflows/images.yml`:

   ```bash
   owner=openupstream
   for package in control-plane operators dashboard example-notes example-spa-api example-worker; do
     token=$(curl -s "https://ghcr.io/token?scope=repository:$owner/$package:pull" | jq -r .token)
     curl -s -o /dev/null -w "$package %{http_code}\n" -H "Authorization: Bearer $token" \
       -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
       "https://ghcr.io/v2/$owner/$package/manifests/main"
   done
   ```

3. For a package that is not public, open your organization's (or account's)
   **Packages**, then the package: **Package settings → Danger Zone → Change
   visibility → Public**.

In a fork, the images are `ghcr.io/<your owner>/…`; the deploy manifests and
`infra/dev-cluster/platform.sh` still say `openupstream`, so adjust them.

Other names that are ours today and need yours:

| What | Where |
| --- | --- |
| The backup bucket | `infra/dev-cluster/database-config.json` (section 4) |
| madAuth's public URL | `MADAUTH_ISSUER` in `infra/dev-cluster/platform.sh` (on the dev cluster `http://localhost:8787`) |
| Our hostname (`console.openupstream.com`: the dashboard, madAuth under `/auth`, the API under `/api`) | decisions 67, 120 and 123; `PLATFORM_DOMAIN`, defaults in `infra/dev-cluster/lib.sh` |
| The waitlist's hostname (`openupstream.com`), only with `SIGNUP=closed` | decision 123; `WAITLIST_DOMAIN` for `infra/dev-cluster/platform.sh` (section 9) |
| The customer domain (`openupstream.app`), under which Buckets are reached | decision 68; `CUSTOMER_DOMAIN`, defaults in `infra/dev-cluster/lib.sh` |

## 3. Development clusters

[infra/dev-cluster](../infra/dev-cluster/README.md) installs the platform
onto a k3s cluster with nodes in three or more Sites, or onto a single node
(#112, [ADR-0004](adr/0004-single-node-dev-cluster.md)). Either needs
sections 4 to 6 (backups, DNS, e-mail, or `MAIL=log` instead of 6).

The Sites are what the nodes say
([ADR-0007](adr/0007-sites-from-node-labels.md)); name them after your own
places. Each node carries its Site's id as `topology.kubernetes.io/zone`;
the nodes of a compute Site carry `openupstream.io/compute-site=true`, those
of the default Home site also `openupstream.io/default-site=true`, every
other node the taint `openupstream.io/third-site=true:NoSchedule`; the
annotation `openupstream.io/site-description` is shown next to the id. The
node setup scripts below set them; the install sets the labels from
`COMPUTE_SITES`, `DEFAULT_SITE` and `SITE_DESCRIPTIONS` and checks them (at
least two compute Sites and three Sites; the
[infra/dev-cluster](../infra/dev-cluster/README.md#sites) README has the
details). A cluster installed before needs its compute Sites once:
`COMPUTE_SITES="hetzner-fsn1 ovh-lim" ./install-multi-node.sh`.

### Hetzner Cloud: three Sites

The Hetzner dev cluster is three Hetzner Cloud VMs created and deleted per
working session (#33, #52); see
[infra/dev-cluster-hetzner](../infra/dev-cluster-hetzner/README.md).

1. In the [Hetzner Cloud Console](https://console.hetzner.cloud), create a
   project for it, e.g. `openupstream-dev`.
2. In that project, generate an API token (under **Security → API
   tokens**) with read and write access.
3. On your machine, store it in the `hcloud` CLI (it asks for the token):

   ```bash
   hcloud context create openupstream-dev
   ```

Three `cpx32` VMs cost about €0.20 an hour together, the two 40 GB volumes
of the compute VMs about €0.005; `infra/dev-cluster-hetzner/down.sh` deletes
everything `up.sh` created. A volume left behind by an interrupted run
shows in `hcloud volume list --selector openupstream=dev`.

### Incus: three Sites on one machine at home

Three Incus VMs on one x86_64 machine in your home network (#137); see
[infra/dev-cluster-incus](../infra/dev-cluster-incus/README.md). The
defaults need 28 GB of RAM visible to Linux (`free -g`; a 32 GB mini PC
with an integrated GPU shows about 28) and about 260 GB of disk, allocated
as used. Nothing needs to be reachable from the internet. Set up first on
a Minisforum UM790 Pro with Ubuntu Server 26.04 (2026-11-27).

1. Install Ubuntu Server (24.04 or 26.04, not minimized) with "Use an
   entire disk" and LVM, no encryption (it would ask for a passphrase at
   every boot), the root volume at its default of about 100 GB and the
   rest of the volume group left free, and OpenSSH. Give the machine a
   fixed address in the router (a DHCP reservation; on a Fritz!Box,
   "IPv4-Adresse dauerhaft zuweisen").
2. Log in with a key of its own, then allow sudo without a password (the
   scripts and the steps below need it) and turn password logins off:

   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/<name> -C <name>
   ```

   ```bash
   ssh-copy-id -i ~/.ssh/<name>.pub <user>@<host address>
   ```

   ```bash
   ssh -t <user>@<host address> 'echo "<user> ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/90-<user> && sudo chmod 440 /etc/sudoers.d/90-<user>'
   ```

   ```bash
   ssh <user>@<host address> 'echo "PasswordAuthentication no" | sudo tee /etc/ssh/sshd_config.d/10-key-only.conf && sudo systemctl reload ssh'
   ```

3. Put its network port on a bridge, so the VMs get addresses from the
   router. Find the port's name and MAC address with `ip -br link` (e.g.
   `enp1s0`), then replace the netplan file the installer wrote
   (`/etc/netplan/00-installer-config.yaml` or `50-cloud-init.yaml`; the
   commands below use the first, put in yours) with
   `/etc/netplan/60-br0.yaml` (mode 600). The bridge takes the port's MAC
   address, so the router's reservation keeps the machine's address:

   ```yaml
   network:
     version: 2
     ethernets:
       enp1s0:
         match:
           macaddress: "<MAC address of the port>"
         set-name: enp1s0
         dhcp4: false
         dhcp6: false
         accept-ra: false
     bridges:
       br0:
         interfaces: [enp1s0]
         macaddress: "<MAC address of the port>"
         dhcp4: true
         dhcp6: true
         parameters:
           stp: false
           forward-delay: 0
   ```

   Over SSH, apply it with a way back: keep a copy of the old file, move
   it away (two files configuring the port would conflict), check the new
   one, schedule the old file's return, apply, reconnect, and only then
   cancel the return:

   ```bash
   sudo cp /etc/netplan/00-installer-config.yaml /root/00-installer-config.yaml.bak && sudo mv /etc/netplan/00-installer-config.yaml /root/ && sudo netplan generate
   ```

   ```bash
   sudo systemd-run --unit=netplan-rollback --on-active=180 sh -c "rm -f /etc/netplan/60-br0.yaml; install -m 600 /root/00-installer-config.yaml.bak /etc/netplan/00-installer-config.yaml; netplan apply"
   ```

   ```bash
   sudo systemd-run --unit=netplan-apply-br0 sh -c "sleep 2; netplan apply"
   ```

   ```bash
   sudo systemctl stop netplan-rollback.timer
   ```

4. Install Incus and give it a btrfs storage pool named `default` on a
   logical volume of its own from the free space (instant snapshots, and
   the VMs cannot fill the root filesystem). It takes 80% of the volume
   group's free space (`sudo vgs` shows it), leaving room to grow the root
   volume later. No Incus network is needed:
   the VMs use `br0`.

   ```bash
   sudo apt install incus btrfs-progs && sudo adduser $USER incus-admin
   ```

   ```bash
   sudo lvcreate -l 80%FREE -n incus ubuntu-vg && sudo incus storage create default btrfs source=/dev/ubuntu-vg/incus
   ```

   ```bash
   sudo incus profile device add default root disk path=/ pool=default
   ```

5. To run the scripts from your machine, let the host's API listen on its
   address and trust your machine's client certificate. Copying the
   certificate needs no token; it is public:

   ```bash
   brew install incus && incus remote generate-certificate
   ```

   The certificate is in `~/Library/Application Support/incus/` on macOS
   and `~/.config/incus/` on Linux:

   ```bash
   scp ~/Library/Application\ Support/incus/client.crt <user>@<host address>:/tmp/client.crt
   ```

   ```bash
   ssh <user>@<host address> 'sudo incus config set core.https_address <host address>:8443 && sudo incus config trust add-certificate /tmp/client.crt --name my-laptop && rm /tmp/client.crt'
   ```

   ```bash
   incus remote add <name> https://<host address>:8443 --accept-certificate
   ```

6. Pick two domains and add them to your router's DNS rebinding
   exceptions, as for a single node below (steps 3 and 4).
7. Run `up.sh` and `install-multi-node.sh` as the
   [infra/dev-cluster-incus](../infra/dev-cluster-incus/README.md) README
   shows, then give the three VMs DHCP reservations.

### A single-node dev cluster

One x86_64 Linux machine (Debian or Ubuntu, 26.04 included, whose AppArmor
needs `infra/apparmor`, which the script installs; about 8 to 12 GB of RAM
for the platform alone) runs the whole platform with one copy of everything, for
development only: losing it loses everything but the Databases' backups.
Nothing needs to be reachable from the internet, and no disk needs
preparing: Databases use k3s's local-path storage on the root filesystem,
not TopoLVM.

1. Give the machine a fixed address in your router (a DHCP reservation):
   its DNS records point at that address. In a Tailscale network, use its
   Tailscale address instead (`NODE_ADDRESS`, in the
   [infra/dev-cluster](../infra/dev-cluster/README.md) README), which stays
   the same anyway; the cluster is then reachable from the tailnet only.
2. Make sure you can log in over SSH as root, or as a user with
   passwordless sudo, and that ports 80, 443 and 6443 are free on it.
3. Pick two domains, one for the platform's hostnames and one for the
   customer domain, each a bunny.net zone (section 5) or a name inside
   one: `home.dev.example.com` in the zone `dev.example.com` needs no new
   zone and no delegation. The scripts create the records in the zone.
4. If your router has DNS rebinding protection, which drops public
   answers that contain a private address, add both domains as exceptions
   (with Tailscale, on the resolver your tailnet devices use; MagicDNS
   forwards public names to it).
   On a Fritz!Box: **Home Network → Network → Network Settings → DNS
   Rebind Protection**, one domain per line.
5. Run `k3s-single-node.sh` and then `install-single-node.sh` with both
   domains, as the [infra/dev-cluster](../infra/dev-cluster/README.md)
   README shows.

Check from inside the network that the names resolve to the machine:

```bash
dig +short home.dev.example.com
```

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

Every cluster may use the same bucket: each archives into a folder named
after its cluster id (`clusterId` in `openupstream-system/cluster-layout`,
generated at install, #149), so the dev clusters, a reinstall and
production never meet. Install production with `CLUSTER_ID=production` for
a folder you recognise.

## 5. bunny.net: DNS

All of openupstream's DNS zones are on bunny.net DNS, whose health checks
drop a failed Site from the ingress records (#32, #34). cert-manager also
uses it for DNS-01 certificate challenges (#69).

The development cluster gets its own subdomains, delegated to bunny.net, so
each session can point records at its VMs while the parent domains stay
where they are (#70): one for our own hostnames, ours
`dev.openupstream.com`, and one under the customer domain for the Buckets,
ours `dev.openupstream.app`. A third, ours `test.openupstream.com`, stands
in for a customer's own zone when trying custom domains, since hostnames in
the other two cannot be claimed (#85). Both parent domains are registered and served
by domaindiscount24. Do steps 2 to 4 once per subdomain.

1. Create an account at [bunny.net](https://bunny.net), then **Billing**:
   top up the balance right away. DNS zones and queries are free, but every
   account pays a minimum of $1 a month from a prepaid balance, and top-ups
   start at $10. The account starts as a 14-day free trial; when it ends
   without a balance, bunny.net disables the account, its zones stop
   resolving, and their data is deleted 14 days later. $10 lasts about ten
   months: set a reminder to top up again, or turn on auto-recharge under
   **Billing**.
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

## 6. Amazon SES: madAuth's e-mails

madAuth's e-mails (address confirmation, password reset) go out through
Amazon SES in an EU region, sent by the madAuth sidecar (#66). Ours: region
`eu-central-1` (Frankfurt), domain `openupstream.com`, sender
`no-reply@openupstream.com`. Route 53 is not needed; the records go wherever
the domain's DNS is (ours: domaindiscount24).

1. **Verify the domain.** In the SES console, in your EU region:
   **Configuration → Identities → Create identity → Domain**, e.g.
   `openupstream.com`.
   - Tick **Use a custom MAIL FROM domain** and enter only the label,
     `mail` (the console appends the domain). Behavior on MX failure: **Use
     default MAIL FROM domain**.
   - **Advanced DKIM settings**: **Easy DKIM**, **RSA_2048_BIT**, DKIM
     signatures enabled, and **Publish DNS records to Route53 unticked**
     (in both places it appears).
2. **Add the records SES shows** at your DNS provider (at domaindiscount24:
   **Create new subdomain** with the name part, then **Edit** for the type
   and value):

   | Name | Type | Value |
   | --- | --- | --- |
   | three `<token>._domainkey` | CNAME | `<token>.dkim.amazonses.com` |
   | `mail` | MX | `10 feedback-smtp.<region>.amazonses.com` |
   | `mail` | TXT | `v=spf1 include:amazonses.com ~all` |
   | `_dmarc` | TXT | `v=DMARC1; p=none;` (add `rua=mailto:<you>` for reports) |

   SES shows the identity as **Verified** once it finds them, usually
   within minutes. Check from the command line:

   ```bash
   aws sesv2 get-email-identity --email-identity openupstream.com --region eu-central-1 --query '{verified:VerifiedForSendingStatus,dkim:DkimAttributes.Status,mailFrom:MailFromAttributes.MailFromDomainStatus}'
   ```

3. **Leave the sandbox.** A new SES account, per region, only sends to
   verified addresses: **Account dashboard → Request production access**.
4. **A key that can only send.** An IAM policy that allows sending only
   through this identity and only as the sender, and an IAM user with just
   that policy. With an admin profile on your machine, save the policy as
   `ses-send-policy.json` (put your account ID and region in):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["ses:SendEmail", "ses:SendRawEmail"],
       "Resource": "arn:aws:ses:eu-central-1:<account id>:identity/openupstream.com",
       "Condition": { "StringEquals": { "ses:FromAddress": "no-reply@openupstream.com" } }
     }]
   }
   ```

   ```bash
   aws iam create-policy --policy-name openupstream-ses-send --policy-document file://ses-send-policy.json
   ```

   ```bash
   aws iam create-user --user-name openupstream-ses
   ```

   ```bash
   aws iam attach-user-policy --user-name openupstream-ses --policy-arn arn:aws:iam::<account id>:policy/openupstream-ses-send
   ```

   The access key goes straight into the profile `openupstream-ses`,
   without showing on screen:

   ```bash
   read -r KEY_ID SECRET <<< "$(aws iam create-access-key --user-name openupstream-ses --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text)" && aws configure set aws_access_key_id "$KEY_ID" --profile openupstream-ses && aws configure set aws_secret_access_key "$SECRET" --profile openupstream-ses && aws configure set region eu-central-1 --profile openupstream-ses; unset KEY_ID SECRET
   ```

5. `infra/dev-cluster/platform.sh` copies this profile into the cluster as
   the Secret `madauth-ses`, which the madAuth sidecar sends with
   (`MAIL=ses`, the default there), and the control plane too, for the
   waitlist's e-mails when sign-up is closed (section 9). Both send as
   the same address, so the policy needs nothing more.
6. **Send a test mail** with that profile, then check the headers (in
   Gmail: **Show original**) for SPF, DKIM and DMARC **PASS**:

   ```bash
   aws sesv2 send-email --profile openupstream-ses --region eu-central-1 --from-email-address no-reply@openupstream.com --destination ToAddresses=<you> --content 'Simple={Subject={Data="SES test"},Body={Text={Data="Sent with the send-only key."}}}'
   ```

## 7. npm: the SDK and the CLI

`@openupstream/sdk` and `@openupstream/cli` are published from GitHub
Actions without a token (#80). Only needed by whoever publishes them;
using them needs nothing. Steps 2 to 4 are once per package (`sdk`, then
`cli`; the CLI needs the SDK version it depends on on npm first).

1. **An npm account** with two-factor authentication, and an
   **organization** `openupstream` (free plan, public packages) at
   <https://www.npmjs.com/org/create>.
2. **The first version by hand**, since trusted publishing can only be set
   up for a package that exists. From a clean checkout of the release
   commit:

   ```bash
   npm login
   ```

   ```bash
   npm ci && npm run build -w sdk && npm publish -w sdk
   ```

   For the CLI, `npm run build -w sdk -w cli && npm publish -w cli`.

3. **On GitHub**, in the repository's settings:
   - an **Environment** `npm-release` with the maintainers as required
     reviewers and, under deployment branches and tags, only the tag
     patterns `sdk-v*` and `cli-v*`;
   - **tag rulesets** "sdk release tags" for `refs/tags/sdk-v*` and "cli
     release tags" for `refs/tags/cli-v*` that restrict creation, update
     and deletion, bypassed only by repository and organization admins.
4. **Trusted publishing**: on the package's page on npmjs.com, **Settings →
   Trusted publisher → GitHub Actions**: organization `openupstream`,
   repository `openupstream`, workflow `sdk-release.yml` (for the CLI
   `cli-release.yml`), environment `npm-release`, allowed action **npm
   publish**. Then, under
   **Publishing access**, require two-factor authentication and disallow
   tokens, so only the workflow can publish.
5. Later versions: a `sdk-v<version>` or `cli-v<version>` tag, then an
   approval on GitHub (sdk/README.md and cli/README.md, "Releasing").

## 8. The CLI's sign-in

`oup login` signs in with madAuth's device authorization grant (ARCHITECTURE.md,
decision 87), as a client an admin registers once per madAuth:

1. Make yourself madAuth's first admin: set `INITIAL_ADMIN_EMAIL` to your
   address (`infra/dev-cluster/platform.sh` passes it to madAuth), sign up
   or sign in with it and confirm the address.
2. Register the client; it asks for your e-mail and password, so neither
   ends up in the shell history:

   ```bash
   infra/madauth/register-cli.sh https://console.openupstream.com
   ```

   It prints `CLI_CLIENT_ID=mc_…`. An admin with a second factor adds the
   client in the browser instead, as the script's header shows.
3. Set `CLI_CLIENT_ID` for the control plane (`platform.sh` takes it from
   the environment) and roll it out. `GET /v1/login` then answers, and
   `oup login --api https://console.openupstream.com/api` works: it opens
   the dashboard, which shows the approval dialog.

## 9. Sign-up and the waitlist

Sign-up is **open by default**: anyone who reaches your madAuth can create
a user, and with no billing service every Account may create Resources.
To keep it that way, set nothing: `platform.sh` runs with `SIGNUP=open`,
and the sidecar lets every new user in (ARCHITECTURE.md, decision 86).

To close it, as the hosted service does until it can invoice:

1. **Write the Impressum** into a text file outside this repository (who
   runs the service, a postal address, an e-mail address; § 5 DDG), e.g.
   `~/.config/openupstream/imprint.txt`. The waitlist page shows it, and its
   privacy notice names that party as the controller. Read the privacy
   notice (`control-plane/src/waitlist/site.ts`) and change what is not
   true for you, such as the providers it names.
2. **Run `platform.sh` with sign-up closed**, your own address allowed so
   you can still create users:

   ```bash
   SIGNUP=closed WAITLIST_DOMAIN=example.com SIGNUP_ALLOW=you@example.com IMPRINT_FILE=~/.config/openupstream/imprint.txt ./platform.sh
   ```

   `WAITLIST_DOMAIN` is the waitlist's own host, a bunny.net zone or a
   name inside one, and never the platform domain, which serves the
   dashboard (decision 123): for the hosted service `openupstream.com`
   next to `console.openupstream.com`. `platform.sh` points it at the
   compute nodes and requests its certificate.
   `SIGNUP_ALLOW` takes addresses and `@domains`, comma-separated. madAuth
   now refuses everyone else, with a message that points to
   `https://$WAITLIST_DOMAIN/waitlist`, where the waitlist page takes e-mail
   addresses (double opt-in, through SES as in section 6; `MAIL=log`
   writes the confirmation links to the control plane's log instead). It
   rolls out madAuth and the control plane when their settings changed.
3. **Check it**: a sign-up with another address is refused, and
   `https://$WAITLIST_DOMAIN` shows the waitlist; confirm an address of
   your own with the link it mails you.

To open sign-up again, run `platform.sh` with `SIGNUP=open` (it removes the
waitlist route and its certificate; remove its DNS record with
`DNS_DOMAIN=$WAITLIST_DOMAIN DNS_NAMES=@ infra/dev-cluster/dns.sh --delete`). The addresses stay in the table
`waitlist` of the control plane's Database: write to the confirmed ones
once, then delete them, as the privacy notice promises.

Where the website is served at that host (section 11), keep the DNS
record: deleting it takes the website down. The waitlist's route goes with
`SIGNUP=open`, and with it `/waitlist`, `/privacy` and `/imprint`, which
the website links to: give the website an Impressum and a privacy notice
of its own first, and change its links and its "Join the waitlist" button
(`website/README.md`).

## 10. Monitoring: alerts and the dead man's switch

The platform watches itself with Prometheus, Alertmanager, Grafana and Loki
(ARCHITECTURE.md, "Observability and customer logs"; decisions 106 and 107),
installed by `infra/dev-cluster/monitoring.sh` as a step of every install:
the control plane reads its Prometheus for what Resources use, for
metering and for storage auto-grow (decision 124). Without `ALERT_EMAIL` it
collects and evaluates but sends nothing, and the steps below are not
needed. With it, alerts go by e-mail through
SES; a dead man's switch at healthchecks.io notices when no alert can be
sent at all.

1. **SES.** Alertmanager sends through SES's SMTP interface with the same
   send-only key as madAuth (section 6), so nothing new is created there:
   the script derives the SMTP password from the key in the profile
   `openupstream-ses` and writes it straight into the cluster. The sender is
   `no-reply@openupstream.com`, which the key's policy allows. While the SES
   account is in its sandbox, the recipient must be a verified address too.
2. **healthchecks.io.** Create an account at https://healthchecks.io (EU
   hosted, free for a few checks) and a check per cluster, e.g.
   `openupstream-dev`, with **Period 1 minute** and **Grace 5 minutes**,
   notifying you by e-mail. Alertmanager pings it every minute with the
   always-firing `Watchdog` alert; when the pings stop, healthchecks.io
   mails you. It receives the alert's labels, never customer data. Copy the
   check's ping URL and save it from the clipboard, so it does not show on
   screen:

   ```bash
   install -m 600 /dev/null ~/.config/openupstream/healthchecks-ping-url-dev
   ```

   ```bash
   pbpaste > ~/.config/openupstream/healthchecks-ping-url-dev
   ```

3. **Install** again, with the address alerts go to:

   ```bash
   ALERT_EMAIL=you@example.com ./monitoring.sh
   ```

4. **Check it**: the check at healthchecks.io turns green within a minute.
   Grafana is at `kubectl -n monitoring port-forward
   svc/kube-prometheus-stack-grafana 3000:80`, user `admin`, with the
   password the script prints how to read.

## 11. The website

Only for the hosted service: `website/` is `openupstream.com`, with pages
that name its hostnames. It is served at the waitlist's host from a Bucket
of an ordinary Project, and the waitlist keeps `/waitlist`, `/privacy` and
`/imprint` (ARCHITECTURE.md, decisions 130 and 132). It needs section 9
done with `SIGNUP=closed`. Unlike the sections above, these steps were
written with the change and have not been done for the hosted service
yet; correct them when they are.

1. **A Project and a Bucket**, signed in as a Member of an Account of
   yours that may create Resources:

   ```bash
   oup project create website --link
   ```

   Create a Bucket on the dashboard's Project page; its name is unique
   across all Projects. `oup project list` shows the Project's id.
2. **Name the Project to the control plane**, so that it alone may claim
   the waitlist's host, by running `platform.sh` again with the settings of
   section 9 and `WEBSITE_PROJECT_ID=<the Project's id>`.
3. **Claim the host** on the dashboard's Project page (Domains), publish
   the TXT record it names at `_openupstream.<WAITLIST_DOMAIN>` in the
   bunny.net zone, and verify. The host already points at the compute
   nodes, so it needs no CNAME.
4. **Add a Route** for `/` to the Bucket, without SPA fallback. The Domain
   gets a certificate of its own with it.
5. **On GitHub**, in the repository's settings: the variables
   `WEBSITE_PROJECT` (the Project's id) and `WEBSITE_BUCKET`; an
   Environment `website` that accepts only the branch `main`, with the
   secret `WEBSITE_API_KEY`, an API key of that Member with the scope
   `openupstream:write`. Create the key in madAuth and paste it into the
   secret's field; it is shown once.
6. **Deploy**: run the workflow "Website" by hand once (Actions → Website →
   Run workflow). From then on it runs on every merge to main that changes
   the site.
7. **Check it**: `https://<WAITLIST_DOMAIN>/` shows the website,
   `/waitlist` the form, and a path the site does not have a 404.

   ```bash
   curl -sI https://openupstream.com/ | head -1
   curl -s https://openupstream.com/waitlist | grep -c 'action="/waitlist"'
   ```

## Coming with build step 2

- **No payment method needed** when you run openupstream yourself: leave
  `NEW_ACCOUNT_HOLDS` empty (the default) and every Account may create
  Resources (ARCHITECTURE.md, decision 78). Your own rules can place and
  lift Holds through the internal API (`BILLING_CALLERS`).
- **Mollie** and **lexoffice**, for the hosted service only: its private
  billing service (#77) takes the payment method an Account needs and the
  payments (#65, #74), and issues the invoices. Its deployment is
  described in its own, private repository; the Mollie and lexoffice
  account setup below has not moved there yet.
  In the Mollie profile, switch on the methods that create a mandate
  (#75): cards (with Apple Pay and Google Pay), PayPal and Pay by Bank,
  plus SEPA Direct Debit, without which Pay by Bank yields no mandate.
  PayPal connected before January 2025 may need connecting again for
  recurring payments.
- The production DNS zones and public hostnames.
- **Storage on the compute servers**: TopoLVM needs the LVM volume group
  `openupstream` on each compute server, made from its NVMe with
  `infra/topolvm/vgcreate.sh <device>` before TopoLVM is installed
  (`infra/topolvm/values.yaml`). The two NVMe disks are mirrored
  (software RAID 1) in two parts, a small one for the operating system and
  the rest left empty for the volume group (ARCHITECTURE.md, decision
  118); the device is that second `/dev/md…`.
