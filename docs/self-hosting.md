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
| `jq`, `curl`, `ssh`, `openssl` | the scripts in `infra/dev-cluster` |
| `dig` | checking DNS delegations (section 5) |

On macOS: `brew install hcloud kubectl awscli jq`.

Then install and build the repository once; the dev-cluster scripts run
code from it (`operators/scripts`, and libraries from `node_modules`):

```bash
npm ci && npm run build
```

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

Other names that are ours today and need yours:

| What | Where |
| --- | --- |
| The backup bucket | `infra/dev-cluster/database-config.json` (section 4) |
| madAuth's public URL | `MADAUTH_ISSUER` in `infra/dev-cluster/platform.sh` (on the dev cluster `http://localhost:8787`) |
| Our hostnames (`openupstream.com`, `api.`) and the customer domain (`openupstream.app`) | decisions 67 and 68; they become settings with build step 2, which is the first to use them |

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
   (`MAIL=ses`, the default there).
6. **Send a test mail** with that profile, then check the headers (in
   Gmail: **Show original**) for SPF, DKIM and DMARC **PASS**:

   ```bash
   aws sesv2 send-email --profile openupstream-ses --region eu-central-1 --from-email-address no-reply@openupstream.com --destination ToAddresses=<you> --content 'Simple={Subject={Data="SES test"},Body={Text={Data="Sent with the send-only key."}}}'
   ```

## Coming with build step 2

- **Mollie** for the payment method an Account needs and its payments (#65,
  #74), and **lexoffice** for the invoices.
  In the Mollie profile, switch on the methods that create a mandate
  (#75): cards (with Apple Pay and Google Pay), PayPal and Pay by Bank,
  plus SEPA Direct Debit, without which Pay by Bank yields no mandate.
  PayPal connected before January 2025 may need connecting again for
  recurring payments.
- The production DNS zones and public hostnames.
