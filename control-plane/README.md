# control-plane

The API behind the dashboard, the CLI and the SDK. Single Node.js process,
own Postgres for state, talks to the Kubernetes API to provision.

Responsibilities:

- accounts, members, API keys (sign-in and keys via madAuth)
- projects and their resources: databases, buckets, sites, services, jobs
- the routing table (`domain → prefix → target`)
- secrets (envelope-encrypted, injected into containers as env)
- usage events (stored here, rolled up hourly to Stripe Billing Meters)

Not here: anything that reconciles cluster state in a loop. That is `operators/`.

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
and `BACKUP_*` settings and the backup credentials). At startup it applies pending migrations and seeds the
platform's own Account, Project and Database rows (`src/platform.ts`), then
listens on `PORT` (8080, public API) and `INTERNAL_PORT` (8081).

In the cluster it runs from the image built by `Dockerfile` (GitHub Actions
pushes it to `ghcr.io/openupstream/control-plane`) with
`deploy/control-plane.yaml`, in the platform Project's namespace next to its
Database. `infra/dev-cluster/platform.sh` bootstraps both.

## Public API

`src/api/` (Hono, zod validation). Every route but `GET /v1/health` needs a
madAuth JWT (`Authorization: Bearer …`), verified against madAuth's JWKS
(`AUTH_JWKS_URL`, or `AUTH_JWKS` inline for tests and the dev cluster) for
`AUTH_ISSUER` and `AUTH_AUDIENCE`. Its subject is a madAuth identity; the
caller acts for every Account it is a Member of. A Project of another
Account answers 404, like one that does not exist.

| Route | |
| --- | --- |
| `GET /v1/projects` | the Projects of the caller's Accounts |
| `POST /v1/projects` | `{accountId, name}` → 201; 409 if the name is taken in the Account |
| `GET /v1/projects/{id}` | |
| `DELETE /v1/projects/{id}` | 202: the Project and its Databases are deleted, see Cleanup |
| `GET /v1/projects/{id}/databases` | with each Database's `state` and in-cluster `connection` |
| `POST /v1/projects/{id}/databases` | `{name, homeSite?, memoryMb, storageGb}` → 201, `state: provisioning` |
| `GET /v1/projects/{id}/databases/{id}` | `state` read live from the Cluster |
| `DELETE /v1/projects/{id}/databases/{id}` | 202 |

The sdk's `OpenUpstreamClient` wraps these. `scripts/dev-token.mjs` mints
tokens for the dev cluster, where there is no madAuth yet.

## Cleanup

Deleting only marks rows (`deleted_at`): the operator stops seeing them at
once, and the name can be used again. `src/cleanup.ts` then, every 30 s and
on one replica at a time (a Postgres advisory lock), removes a deleted
Database's Cluster, Pooler and ScheduledBackup; after `BACKUP_RETENTION` it
deletes the Database's backup folder from the bucket, its ObjectStore and its
row; and once a deleted Project has no Database rows left, its namespace and
its row. Until the retention has passed a deleted Database can be restored
into a new one (`docs/runbooks/restore-from-backup.md`).

## Internal API

For the operators only, on its own port, never routed by ingress
(`src/internal/`). Callers send their ServiceAccount token for the audience
`openupstream-control-plane`; a TokenReview confirms it, and only the
ServiceAccounts in `ALLOWED_CALLERS` (default: the Databases operator) get an
answer: 401 without a valid token, 403 for anyone else, 503 when the token
cannot be checked.

- `GET /internal/v1/databases`: every Database with its Project
  (`DatabaseRow` in `sdk/src/internal.ts`).

The control plane's ServiceAccount is bound to `system:auth-delegator` to
create TokenReviews.

## Secrets

`src/secrets/envelope.ts` holds the envelope encryption as pure functions;
`src/secrets/store.ts` stores and reads Secrets with it. The key-encryption
key is 32 random bytes, base64 encoded, with an id
(`parseKeyEncryptionKey`); the wrapped data keys record that id.

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
