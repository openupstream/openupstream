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
