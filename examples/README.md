# examples

Demo apps that prove each build step end to end on the platform
(ARCHITECTURE.md, decisions 29, 30 and 99). Each is a folder with a
`server.ts` on plain `node:http`, with `pg` for a Database and the AWS SDK's
S3 client for a Bucket, built into its own image by the Images workflow:

```bash
docker build -f examples/Dockerfile --build-arg APP=notes -t example-notes .
```

## notes

A Service with a Postgres Database: `ghcr.io/openupstream/example-notes`.
It reads `DATABASE_URL`, which every Service of a Project with a Database
gets (decision 97), creates its table on start and serves:

| Route | |
| --- | --- |
| `GET /` | the newest 50 notes and a form |
| `POST /notes` | the form: `body`, then a redirect to `/` |
| `GET /api/notes` | the newest 50 notes as JSON |
| `POST /api/notes` | `{"body": "…"}` → 201 with the note; 400 for no text or no JSON, 413 over 8 KiB |
| `GET /healthz` | 200 while the process runs |
| `GET /readyz` | 200 while the database answers, else 503 |

A failing database is a 503 for its routes, never a crash, so the
acceptance test's writes during a Site failure show the gap and nothing
else. On the platform:

```bash
oup service deploy notes --image ghcr.io/openupstream/example-notes:main --port 8080
```

with a Database in the Project and a Route from `/` to the Service.
Locally, against any Postgres:

```bash
DATABASE_URL=postgres://… npx tsx examples/notes/server.ts
```

## spa-api

A single-page app from a Bucket at `/` and its API, a Service at `/api` on
the same hostname, which keeps files in a second Bucket
(`ghcr.io/openupstream/example-spa-api`, decision 100). The app is plain
files in `spa-api/site`, no build step: a list with an upload form at `/`
and one file at `/files/<name>`, a deep link that only the Route's SPA
fallback can serve.

The API keeps the `/api` prefix, since a Route to a Service passes the path
on unchanged:

| Route | |
| --- | --- |
| `GET /api/files` | the first 100 files by name: `[{name, size, lastModified}]` |
| `PUT /api/files/{name}` | the body as the file, its `content-type` kept → 200; 400 for a bad name, 413 over 1 MiB |
| `GET /api/files/{name}` | the file as a download (`attachment`, CSP `sandbox`), also as `HEAD`; 404 if there is none |
| `DELETE /api/files/{name}` | 204 |
| `GET /healthz` | 200 while the process runs |
| `GET /readyz` | 200 while the Bucket answers, else 503 |

A name has 1 to 100 letters, digits, dots, dashes or underscores and does
not start with a dot, dash or underscore. Anyone who reaches the app may
upload and delete: it is a demo, with nothing to sign in to.

It reads the files Bucket's access from four Secrets, each copied from the
`access` the API shows for the Bucket (`GET /v1/projects/{id}/buckets/{id}`):

| Secret | from `access` |
| --- | --- |
| `BUCKET_ENDPOINT` | `endpoint`, `https://<bucket>.s3.<domain>` |
| `BUCKET_REGION` | `region` |
| `BUCKET_ACCESS_KEY_ID` | `accessKeyId` |
| `BUCKET_SECRET_ACCESS_KEY` | `secretAccessKey` |

On the platform, with two Buckets in the Project, one for the site and one
for the files:

```bash
printf %s "$SECRET_ACCESS_KEY" | oup secret set BUCKET_SECRET_ACCESS_KEY   # and the other three
oup service deploy spa-api --image ghcr.io/openupstream/example-spa-api:main --port 8080
oup site deploy examples/spa-api/site --bucket <site bucket>
```

then the Routes `/` to the site Bucket with `spaFallback: true` and `/api`
to the Service on the Project's Domain. Locally, against any S3 that
serves the Bucket at its own hostname:

```bash
BUCKET_ENDPOINT=http://uploads.s3.localhost:3900 BUCKET_REGION=garage \
BUCKET_ACCESS_KEY_ID=… BUCKET_SECRET_ACCESS_KEY=… npx tsx examples/spa-api/server.ts
```

## worker

A queue on the Project's Database, worked by a Service without a port and
fed and cleaned up by Jobs (`ghcr.io/openupstream/example-worker`, decision
102): step 4's Cron and One-off jobs and a worker Service (decision 98), on
`SELECT … FOR UPDATE SKIP LOCKED` (decision 8). One image, three commands:

| Command | Runs as | Does |
| --- | --- | --- |
| the image's own (`worker/server.js`) | a Service with `--no-port`, any number of replicas | takes the oldest open task no other replica holds, stores the SHA-256 of its payload and its hostname as the worker, in one transaction; polls every second when the queue is empty |
| `node examples/dist/worker/enqueue.js [count]` | a One-off job | adds `count` tasks (1 to 10000, default 10) as a batch and waits until all are done, then exits 0 and logs the tasks done per worker |
| `node examples/dist/worker/cleanup.js [hours]` | a Cron job | deletes the tasks done more than `hours` ago (default 24), as a TTL would |

A task is taken and done in one transaction, so a worker stopped or
crashing midway leaves it open for the next. The Pooler runs in transaction
mode, which has no `LISTEN`, so the worker polls. It reads `DATABASE_URL`
(decision 97) and creates its table on start, as do the Jobs. `WORK_MS`
(default 100) is how long a task takes, so the share of each replica
shows. On SIGTERM it finishes the task at hand and ends; while the
database is away it logs and retries every 2 s.

On the platform, with a Database in the Project:

```bash
oup service deploy worker --image ghcr.io/openupstream/example-worker:main --no-port --replicas 2
oup job deploy enqueue --image ghcr.io/openupstream/example-worker:main --timeout 600 -- node examples/dist/worker/enqueue.js
oup job deploy cleanup --image ghcr.io/openupstream/example-worker:main --schedule '0 3 * * *' -- node examples/dist/worker/cleanup.js
oup job run enqueue -- 100
```

`oup job run enqueue -- 100` exits 0 once both replicas have done all 100
tasks; without a worker, the Job's timeout fails the run.
`oup job run cleanup -- 0` deletes every done task at once. Locally,
against any Postgres:

```bash
DATABASE_URL=postgres://… npx tsx examples/worker/server.ts
DATABASE_URL=postgres://… npx tsx examples/worker/enqueue.ts 20
```
