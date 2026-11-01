# cli

`oup` — the openupstream command line tool. Built on `@openupstream/sdk`.

```sh
npm i -g @openupstream/cli
oup login
oup link shop
oup service deploy api --image ghcr.io/acme/api:v3 --port 8080
printf %s "$STRIPE_KEY" | oup secret set STRIPE_KEY
oup site deploy dist --bucket my-site
```

- `oup login [--api <url>] [--no-browser]`: signs in through madAuth's
  device authorization grant (ARCHITECTURE.md, decision 87). It opens the
  approval page with the code filled in; over SSH, or with `--no-browser`,
  it prints the URL and the code to open on any device. The tokens go to
  `$XDG_CONFIG_HOME/openupstream/credentials.json` (`~/.config/…`, mode
  600); the access token is refreshed when it has less than a minute left,
  by one `oup` process at a time (a lock file next to it).
- `oup logout`: forgets them and ends the CLI's refresh tokens at madAuth.
- `oup link <project>`: the Project the commands below act on, by name
  (or id, when two of your Accounts have one of that name). It writes the
  id to `.openupstream.json` in this directory; commands in it or below
  find it, as git finds `.git`. It holds no secret and may be committed.
  `--project <name|id>`, or `OUP_PROJECT` in CI, names another Project for
  one command.
- `oup service deploy <name> --image <ref> [--port <n>] [--replicas <n>]
  [--memory <MB>] [--cpu <millicores>] [--site hetzner-fsn1|ovh-lim]
  [--registry-user <user> --registry-password-stdin] [--no-wait]`: brings
  the Service to what the flags say (ARCHITECTURE.md, decision 94). A new
  one needs `--port`; memory, CPU and replicas default to 256 MB, 250
  millicores and 1. An existing one gets what differs, and flags left out
  keep what it has. Either way the tag is resolved again, so every deploy
  runs what the tag points at now, pinned by digest. Then it waits until the
  Service is running (up to 5 minutes), unless `--no-wait`. The registry
  password comes from stdin.
- `oup service list`, `oup service show <name>` (JSON),
  `oup service delete <name>` (refused while a Route serves it).
- `oup secret list` (names only), `oup secret set <NAME>`, `oup secret
  delete <NAME>`. The value comes from stdin, never from an argument, which
  shells keep in their history: piped (one trailing line break is dropped,
  as `echo` adds it) or typed at the prompt, which does not echo it. The
  Project's Services restart with the new value.
- `oup site deploy <dir> --bucket <name> [--keep] [--force]`: makes the
  Bucket mirror the directory (decision 88): changed files only, `index.html`
  files last, then deletes what the directory no longer has, unless
  `--keep`. `--force` uploads every file, which also rewrites the headers
  of objects another S3 client uploaded. Cache
  headers come from the name: hashed assets a year and immutable,
  `index.html` `no-cache`, the rest five minutes.

In CI, set `OUP_API_KEY` to a madAuth API key instead of signing in, and
`OUP_API_URL` for another API than `https://api.openupstream.com`.

`src/oidc.ts` is the device grant and refresh, `src/session.ts` the token
for each call, `src/deploy.ts` the site deploy (`planDeploy` is pure),
`src/project.ts` the linked Project, `src/services.ts` the Service deploy
(`planServiceDeploy` is pure) and `src/stdin.ts` reading secret values.
