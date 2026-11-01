# examples

Demo apps that prove each build step end to end on the platform
(ARCHITECTURE.md, decisions 29, 30 and 99). Each is a folder with a
`server.ts` on plain `node:http` and `pg`, built into its own image by the
Images workflow:

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
