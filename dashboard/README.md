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
- The API is at `api.` in front of the dashboard's hostname, or where
  `NEXT_PUBLIC_API_URL` says at build time. The browser sends the session
  cookie along (`session: 'cookie'` in the SDK); the API accepts it from
  the origins in its `DASHBOARD_ORIGINS`.

## Development

```sh
NEXT_PUBLIC_API_URL=http://localhost:8080 npm run dev -w dashboard
```

serves it at `http://localhost:3000` and passes `/auth/*` and
`/.well-known/*` on to a madAuth server at `MADAUTH_URL` (default
`http://localhost:8787`), as the ingress does on a cluster. It needs:

- a madAuth server with `MADAUTH_ISSUER` and `ALLOWED_ORIGINS` set to
  `http://localhost:3000` and e-mail and password on, e.g.
  `npx @madauth/server@0.7.0 init --app-url http://localhost:3000 --password --webhook-url http://127.0.0.1:8788/webhooks`
  and `npx @madauth/server@0.7.0 start --env-file .env`, with the control
  plane's sidecar as its webhook receiver
  (`WEBHOOK_SECRET=… MAIL=log node control-plane/dist/madauth-sidecar.js`
  writes the e-mails, with their codes, to its log)
- the control plane with `AUTH_ISSUER=http://localhost:3000`,
  `MADAUTH_URL=http://localhost:8787` and
  `DASHBOARD_ORIGINS=http://localhost:3000`. Accounts and Projects need
  only its Postgres. Point `KUBECONFIG` at a file that names no real
  cluster: the control plane otherwise works on whichever cluster your
  kubeconfig selects.

`npm run build -w dashboard` writes the static files to `dashboard/out`.
Nothing serves them on a cluster yet (ARCHITECTURE.md, Open question 22);
at `openupstream.com` they take the paths the waitlist page serves while
sign-up on the hosted service is closed (decision 86).

## Tests

`npm test -w dashboard` runs the tests of the pure parts (`src/lib`).
