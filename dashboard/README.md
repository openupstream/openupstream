# dashboard

The web UI of openupstream: a Next.js app built as static files
(ARCHITECTURE.md, decision 116). Every page renders in the browser, which
calls the API itself through `@openupstream/sdk`.

What it does now:

- sign-in and sign-up with madAuth's dialog (`@madauth/web`, e-mail and
  password), sign-out, and the dialog for the Member's API keys
- the approval dialog of `oup login`, when opened with
  `?madauth_device=<code>` (decision 87)
- an Account on the first visit (decision 62)
- Projects: list, create, delete

Pages for Databases, Buckets, Domains, Services, Jobs and Secrets follow.

## How it reaches madAuth and the API

- madAuth is expected on the dashboard's own origin under `/auth/*` and
  `/.well-known/*` (decision 67). It keeps the session in an HttpOnly
  cookie, so no script holds a credential.
- The API is under `/api` of the dashboard's own host (decision 120), so
  the browser sends the session cookie along (`session: 'cookie'` in the
  SDK) and no other host ever receives it. The API accepts the cookie
  only with the browser's `Sec-Fetch-Site: same-origin`, which browsers
  send to HTTPS and localhost origins only: the dashboard does not work
  over plain HTTP on another host.

## Development

```sh
npm run dev -w dashboard
```

serves it at `http://localhost:3000` and, as the ingress does on a
cluster, passes `/auth/*` and `/.well-known/*` on to a madAuth server at
`MADAUTH_URL` (default `http://localhost:8787`) and `/api/*`, without the
prefix, to the control plane at `API_URL` (default
`http://localhost:8080`). It needs:

- a madAuth server with `MADAUTH_ISSUER` and `ALLOWED_ORIGINS` set to
  `http://localhost:3000` and e-mail and password on, e.g.
  `npx @madauth/server@0.7.0 init --app-url http://localhost:3000 --password --webhook-url http://127.0.0.1:8788/webhooks`
  and `npx @madauth/server@0.7.0 start --env-file .env`, with the control
  plane's sidecar as its webhook receiver
  (`WEBHOOK_SECRET=… MAIL=log node control-plane/dist/madauth-sidecar.js`
  writes the e-mails, with their codes, to its log)
- the control plane with `AUTH_ISSUER=http://localhost:3000` and
  `MADAUTH_URL=http://localhost:8787`. Accounts and Projects need
  only its Postgres. Point `KUBECONFIG` at a file that names no real
  cluster: the control plane otherwise works on whichever cluster your
  kubeconfig selects.

`npm run build -w dashboard` writes the static files to `dashboard/out`.

## On a cluster

`dashboard/Dockerfile` puts the static files into an unprivileged nginx
image (`deploy/nginx.conf`: no framing by other sites, `no-cache` for the
pages, a year for the content-named files under `/_next/static/`). The
Images workflow publishes it as `ghcr.io/openupstream/dashboard`, and
`infra/dev-cluster/platform.sh` installs `deploy/dashboard.yaml`: two
replicas, one per compute Site, behind every path of the platform domain
that madAuth and the API do not have (decision 121). It has no settings
and talks to nothing. For the hosted service that host is
`console.openupstream.com`; `openupstream.com` is the welcome page with the
waitlist and never shows the dashboard.

```sh
docker build -f dashboard/Dockerfile -t dashboard . && docker run --rm --read-only --tmpfs /tmp -p 8080:8080 dashboard
```

serves the files alone at `http://localhost:8080`, without madAuth or the
API behind it.

## Tests

`npm test -w dashboard` runs the tests of the pure parts (`src/lib`).
