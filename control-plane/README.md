# control-plane

The API behind the dashboard, the CLI and the SDK. Single Node.js process,
own Postgres for state, talks to the Kubernetes API to provision and to
Garage's admin API for Buckets.

Responsibilities:

- accounts, members, API keys (sign-in and keys via madAuth), and the Holds
  that stop an Account from creating Resources
- projects and their resources: databases, buckets, sites, services, jobs
- the routing table (`domain → prefix → target`)
- secrets (envelope-encrypted, injected into containers as env)
- usage events (stored here; rated, invoiced and collected by the private
  billing service)

Not here: anything that reconciles cluster state in a loop. That is
`operators/`. Nor payments: the billing service (ARCHITECTURE.md, decision
77) sees Accounts through the internal API and holds them until they have a
payment method.

## Schema

Plain SQL migrations in `migrations/`, applied with
[node-pg-migrate](https://salsita.github.io/node-pg-migrate/); each file has an
`-- Up Migration` and a `-- Down Migration` part. The tables and what they
enforce are described at the top of each migration and in `ARCHITECTURE.md`.

```sh
DATABASE_URL=postgres://… npm run migrate -w control-plane up
npm run migrate:create -w control-plane add-something
```

`src/db/migrate.ts` runs the same migrations from code.

## Running

`npm run build -w control-plane`, then `node control-plane/dist/index.js`
with the environment `src/config.ts` lists (`DATABASE_URL`, the `AUTH_*`
and `BACKUP_*` settings and the backup credentials; Garage's admin API and
S3 API inside the cluster, `GARAGE_ADMIN_URL` and `GARAGE_S3_URL`, with
`GARAGE_ADMIN_TOKEN`; the key-encryption key for Secrets, `SECRETS_KEK`
(32 bytes, base64) with its id `SECRETS_KEK_ID`; optionally `CLI_CLIENT_ID`, the client ID of `oup`
in madAuth (`infra/madauth/register-cli.sh`); `CUSTOMER_DOMAIN`, under which Buckets are reached
at `<bucket>.s3.<CUSTOMER_DOMAIN>`; `PLATFORM_DOMAIN`, our own hostnames,
which like `CUSTOMER_DOMAIN` cannot be claimed as custom domains; optionally
`NEW_ACCOUNT_HOLDS`, the Holds every new Account starts with, e.g.
`payment-method`, and `BILLING_CALLERS`, the billing service's
ServiceAccount; `ROUTES_CALLERS`, default the Routes operator's;
`SERVICES_CALLERS`, default the Services operator's). At
startup it applies pending migrations, seeds the platform's own Account,
Project and Database rows (`src/platform.ts`) and gives every Project
without one its default Domain, then listens on `PORT` (8080, public API) and `INTERNAL_PORT` (8081).

In the cluster it runs from the image built by `Dockerfile` (GitHub Actions
pushes it to `ghcr.io/openupstream/control-plane`) with
`deploy/control-plane.yaml`, in the platform Project's namespace next to its
Database. `infra/dev-cluster/platform.sh` bootstraps both.

## Public API

`src/api/` (Hono, zod validation). Every route but `GET /v1/health` and
`GET /v1/login` needs a madAuth credential as `Authorization: Bearer …`
(`src/api/auth.ts`): a session token, verified against madAuth's JWKS
(`MADAUTH_URL`, madAuth inside the cluster) for the issuer `AUTH_ISSUER`;
an access token `oup login` got (`typ: at+jwt`, verified the same way, with
`aud` = `CLI_CLIENT_ID`), which may do what a session may; or an API key
(`madauth_…`), which madAuth checks for us; a key needs `openupstream:read`
for GET and `openupstream:write` for anything else. The caller acts for
every Account its madAuth user is a Member of. A Project of another
Account answers 404, like one that does not exist. An Account with a Hold
gets 402 when it creates a Resource, with `{error, holds}`.

| Route | |
| --- | --- |
| `GET /v1/login` | no token needed: `{issuer, clientId}`, where `oup login` signs in with the device grant; 404 without `CLI_CLIENT_ID` |
| `GET /v1/accounts` | the caller's Accounts, each with its `holds` |
| `POST /v1/accounts` | `{name}` → 201: a new Account, the caller its first Member |
| `GET /v1/projects` | the Projects of the caller's Accounts |
| `POST /v1/projects` | `{accountId, name}` → 201, with its default Domain `<name>-<random>.<CUSTOMER_DOMAIN>`; 409 if the name is taken in the Account |
| `GET /v1/projects/{id}` | |
| `DELETE /v1/projects/{id}` | 202: the Project and its Databases and Buckets are deleted, see Cleanup; its Domains and Routes at once |
| `GET /v1/projects/{id}/databases` | with each Database's `state` and in-cluster `connection` |
| `POST /v1/projects/{id}/databases` | `{name, homeSite?, memoryMb, storageGb}` → 201, `state: provisioning`; 402 if the Account has a Hold |
| `GET /v1/projects/{id}/databases/{id}` | `state` read live from the Cluster |
| `DELETE /v1/projects/{id}/databases/{id}` | 202 |
| `GET /v1/projects/{id}/buckets` | the Buckets, without their keys |
| `POST /v1/projects/{id}/buckets` | `{name}` → 201 with `access`: the Bucket's `endpoint`, `region` and its own key; 409 if the name is taken in any Project, also by a Bucket still being deleted; 402 if the Account has a Hold; 503 if Garage cannot be reached |
| `GET /v1/projects/{id}/buckets/{id}` | with `access`, the secret read from Garage; an API key with only `openupstream:read` gets no secret, since the Bucket's key may write |
| `DELETE /v1/projects/{id}/buckets/{id}` | 202: its key is deleted at once, the Bucket with every object by the next cleanup pass; 409 while a Route serves it |
| `GET /v1/projects/{id}/domains` | the Project's Domains, the default one first |
| `POST /v1/projects/{id}/domains` | `{hostname}` → 201: a custom domain, pending, with the TXT record (`_openupstream.<hostname>`, a random token) that proves it; 400 for a hostname under `CUSTOMER_DOMAIN` or `PLATFORM_DOMAIN`; 409 if the Project has claimed it already or another Project has verified it |
| `POST /v1/projects/{id}/domains/{id}/verify` | looks the TXT record up now → 200 with the Domain verified (it stays so), its Routes served from the next Routes operator pass, with a certificate of its own once its CNAME points at `ingress.<CUSTOMER_DOMAIN>` (set it before the first Route; a failed certificate is retried after an hour); 409 if the record is not there yet (with the values found) or another Project verified the hostname first; 503 if DNS cannot be asked |
| `DELETE /v1/projects/{id}/domains/{id}` | 204: the custom domain and its Routes; a Bucket left without Routes stops being served by Garage; 409 for the default Domain |
| `GET /v1/projects/{id}/domains/{id}/routes` | the Domain's Routes, longest prefix first |
| `POST /v1/projects/{id}/domains/{id}/routes` | `{pathPrefix, bucketId, spaFallback?}` or `{pathPrefix, serviceId}` → 201: the Bucket is served below the prefix (stripped), or the Service gets the requests with their path unchanged, within one Routes operator pass; 400 for a Bucket or Service not in the Project; 409 if the prefix is taken, or if the Bucket's other Routes have another `spaFallback`; 503 if Garage cannot be reached |
| `DELETE /v1/projects/{id}/domains/{id}/routes/{id}` | 204; the Bucket's last Route also stops Garage serving it |
| `GET /v1/projects/{id}/services` | with each Service's `state`, read live from its Deployment |
| `POST /v1/projects/{id}/services` | `{name, image, port, memoryMb, cpuMillicores, replicas?, homeSite?, registryAuth?}` → 201, `state: deploying`, the image pinned to the digest its tag points at now (`src/registry.ts`); 400 for an image the registry does not have or will not serve with `registryAuth` (`{username, password}`, never returned), or a registry at a private address; 503 if the registry cannot be reached; 409 if the name is taken in the Project; 402 if the Account has a Hold |
| `GET /v1/projects/{id}/services/{id}` | `state`: `deploying` (also until the Services operator has applied the latest change: its Deployment carries the spec version of the row), `running`, `degraded`, or `unknown` when Kubernetes cannot be asked |
| `PATCH /v1/projects/{id}/services/{id}` | any of `image, port, replicas, memoryMb, cpuMillicores, homeSite, registryAuth` (`null` removes the last two); a new image or new credentials resolve the tag again; a new image at another registry without new credentials drops the stored ones |
| `POST /v1/projects/{id}/services/{id}/deploy` | resolves the same tag again and pins what it points at now |
| `DELETE /v1/projects/{id}/services/{id}` | 202: the row goes at once, the Deployment with the next Services operator pass; 409 while a Route serves it |
| `GET /v1/projects/{id}/secrets` | the Project's Secrets, names and times only |
| `PUT /v1/projects/{id}/secrets/{name}` | `{value}` → 201 for a new Secret, 200 for a new value; written into the Project's Kubernetes Secret right after the answer (or by the next secrets pass, before the Project has a namespace). The name is an environment variable name; 400 for a value over 64 KiB, or if the Project's values together would pass 512 KiB |
| `DELETE /v1/projects/{id}/secrets/{name}` | 204 |

A Bucket name is a hostname label of 3 to 63 characters. Creating one
creates its Garage bucket (the name as its global alias) and a key that may
read and write only that bucket, through Garage's admin API while the
request waits (`src/garage.ts`); the row is inserted only after Garage has
both, and if the insert fails, the Garage bucket is deleted again.

The sdk's `OpenUpstreamClient` wraps these. `scripts/dev-token.mjs` mints
madAuth-shaped session tokens for running the control plane without madAuth
(`AUTH_JWKS` with its public key).

## madAuth sidecar

`src/madauth-sidecar.ts`, run from this image next to madAuth in its pod
(`infra/madauth`): madAuth only calls https or localhost URLs, so this serves
it on 127.0.0.1:8788 the API key scopes (`GET /api-key-scopes`) and receives
its webhooks (`POST /webhooks`, Standard Webhooks signatures with
`WEBHOOK_SECRET`). E-mails (`src/madauth/mail.ts`) go through Amazon SES
with `MAIL=ses` (`MAIL_FROM`, `SES_REGION` and the send-only key in
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`), to the log with `MAIL=log`,
and are refused without `MAIL`.

## Cleanup

Deleting only marks rows (`deleted_at`): the operator stops seeing them at
once, and a Database's name can be used again. `src/cleanup.ts` then, every 30 s and
on one replica at a time (a Postgres advisory lock), removes a deleted
Database's Cluster, Pooler and ScheduledBackup, and again on every pass for
5 minutes, in case an operator pass that read the row before the delete
re-applies them; after `BACKUP_RETENTION` it
deletes the Database's backup folder from the bucket, its ObjectStore and its
row. Until the retention has passed a deleted Database can be restored
into a new one (`docs/runbooks/restore-from-backup.md`).

A deleted Bucket keeps nothing: the next pass deletes its key, if the
DELETE could not already (so nothing written meanwhile is lost unnoticed),
deletes every object and unfinished upload
with the control plane's own Garage key (`openupstream-control-plane`,
created on first use), then the Garage bucket and the row. Until then its
name stays taken.

Once a deleted Project has neither Database nor Bucket rows left, the pass
removes its namespace and its row.

## Internal API

For the operators and the billing service, on its own port, never routed
by ingress (`src/internal/`). Callers send their ServiceAccount token for
the audience `openupstream-control-plane`; a TokenReview confirms it, and
only the ServiceAccounts listed for the route get an answer: 401 without a
valid token, 403 for anyone else, 503 when the token cannot be checked.

- `GET /internal/v1/routes`: every Domain with Routes to live Buckets or
  Services, with its Project and each Route's Bucket name or Service id and
  port (`DomainRouting`). For
  `ROUTES_CALLERS` (default: the Routes operator).
- `GET /internal/v1/services`: every Service of a live Project with the
  image pinned by digest, the Site a single replica runs in and a version of
  the Project's Secrets that changes with them (`ServiceRow`). For
  `SERVICES_CALLERS` (default: the Services operator).
- `GET /internal/v1/databases`: every Database with its Project
  (`DatabaseRow` in `sdk/src/internal.ts`). For `ALLOWED_CALLERS`
  (default: the Databases operator).
- `GET /internal/v1/accounts/{id}`: the Account with its Holds and Members
  (`AccountRecord`). For `BILLING_CALLERS` (default: none).
- `PUT` and `DELETE /internal/v1/accounts/{id}/holds/{reason}`: place or
  lift a Hold; 204 whether or not it was there, 404 for an unknown Account.
  A reason is a DNS label. For `BILLING_CALLERS`.

The control plane's ServiceAccount is bound to `system:auth-delegator` to
create TokenReviews.

## Secrets

`src/secrets/envelope.ts` holds the envelope encryption as pure functions;
`src/secrets/store.ts` stores and reads Secrets with it. The key-encryption
key is 32 random bytes, base64 encoded, with an id
(`parseKeyEncryptionKey`); the wrapped data keys record that id.

`src/secrets/render.ts` writes a Project's values into the Kubernetes
Secret `project-secrets` in its namespace, and its Services' registry
credentials into the dockerconfigjson Secret `project-registry-auth`, with server-side apply under the
field manager `openupstream-control-plane`: the API does so after every
change, and the secrets pass every `CLEANUP_INTERVAL_SECONDS` for every
live Project that has a data key, on one replica at a time (its own
advisory lock). A Project without a namespace yet is skipped until an
operator has created it.

## Tests

The schema and store tests run against a real Postgres. Each test file
creates its own database and drops it afterwards.

- With `TEST_DATABASE_URL` set (CI does this), they use that server.
- Otherwise they start `postgres:17-alpine` in Docker with
  [testcontainers](https://node.testcontainers.org). With Colima, point
  testcontainers at its socket:

  ```sh
  export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock
  export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
  ```
