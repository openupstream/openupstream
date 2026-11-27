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
- Projects: list, create, delete; a Member without a role in the Account
  (decision 139) sees its Projects without create and delete, and a
  Project's page with only the Databases their grants name, each with its
  level and the `oup pg proxy` command to reach it
- a Project's page (`/project?id=<id>`), asked again every 10 seconds
  while it is in front:
  - Databases: list with state, create (name, memory, storage, Site),
    connection details, resize, delete
  - Services: list with state, image and digest; deploy (name, image,
    port or none for a worker, replicas, memory, CPU, Site), change,
    redeploy what the tag points at now, delete. Public images only: a
    private registry's password is given to `oup service deploy`, never
    typed into the page (decision 127).
  - Jobs: list with state, image, digest and schedule; deploy (name,
    image, schedule, time zone, timeout, memory, CPU, Site), change,
    redeploy, start a run, delete. Their runs of the last day, read while
    the list is open, with stop and remove. A Job from the page runs the
    image's own command, from a public image; another command and a run's
    arguments and variables are given to `oup` (decision 129).
  - Secrets: names with the time their value was set, delete. A value is
    set with `oup secret set`, never typed into the page (decision 129).
  - Logs of a Service and of a run: a live tail (decision 131), open only
    while its "Logs" is and the tab is looked at; the newest 2000 lines.
  - Buckets: list with the S3 endpoint and the addresses Routes serve them
    at, create, delete. A Bucket's key is not shown and never fetched
    (decision 128): it comes from `oup bucket export-env` or
    `show-access-key` (decision 133), and `oup site deploy` gets it itself.
  - Domains: the default Domain and custom domains, claimed with a
    hostname, with the TXT record that proves ownership and the CNAME to
    publish, verify, delete. Per Domain its Routes: add (path, a Bucket
    or a Service with a port, the fallback to `index.html` for a
    single-page app) and delete.
  - what every Resource uses now, from the API's `/usage` (decision 124):
    CPU, memory and storage against what it was given, and its instances
    with their Site, state and restarts.

- `/cli`: how to use `oup`, for anyone, signed in or not (decision 125).
  The text is the part of `cli/README.md` between its `docs` comments, read
  when the dashboard is built (`src/app/cli/page.tsx`) and shown by
  `src/lib/docs.ts`, which knows paragraphs, list items, code blocks and
  inline code and leaves out pointers to decisions. On an installation
  other than the hosted service the page names its own API address, in a
  note and in the example's `oup login --api …`.

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
that madAuth and the API do not have (decision 123). It has no settings
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
