# cli

`oup` — the openupstream command line tool. Built on `@openupstream/sdk`.

```sh
npm i -g @openupstream/cli
oup login
oup link shop
oup pg create main --memory 512 --storage 10
oup service deploy api --image ghcr.io/acme/api:v3 --port 8080
oup job deploy nightly --image ghcr.io/acme/api:v3 --schedule '0 3 * * *' --time-zone Europe/Berlin -- node dist/nightly.js
oup job deploy migrate --image ghcr.io/acme/api:v3 -- npm run migrate && oup job run migrate
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
- `oup pg create <name> [--memory <MB>] [--storage <GB>] [--site hetzner-fsn1|ovh-lim] [--no-wait]`:
  a Database with its primary in the Site (default `hetzner-fsn1`) and a
  standby in the other one, 256 MB and 1 GB unless told otherwise. It waits
  until both instances are ready, unless `--no-wait`. The Project's
  Services and Jobs get its URL as `DATABASE_URL_<NAME>` (decision 97).
- `oup pg restore <source> <name> [--time <RFC 3339>] [--memory <MB>] [--storage <GB>] [--site …] [--no-wait]`:
  a new Database `<name>` that starts as a copy of `<source>` at `--time`
  (with its zone, e.g. `2026-11-10T09:30:00Z`), or at the latest point its
  backups reach without it (decision 108). `<source>` keeps running; point
  the application at the new Database (its own `DATABASE_URL_<NAME>`) once
  it looks right. Size and Site default to the source's. A deleted Database
  is restored by its id, which `oup pg delete` prints, within the backup
  retention window, with `--storage`. The time must lie after the source's
  oldest base backup and at least 5 minutes in the past (WAL reaches the
  archive up to that late).
- `oup pg list`, `oup pg show <name>` (JSON), `oup pg delete <name>`.
- `oup service deploy <name> --image <ref> [--port <n> | --no-port] [--replicas <n>]
  [--memory <MB>] [--cpu <millicores>] [--site hetzner-fsn1|ovh-lim]
  [--registry-user <user> --registry-password-stdin] [--no-wait]`: brings
  the Service to what the flags say (ARCHITECTURE.md, decision 94). A new
  one needs `--port`, or `--no-port` for a worker that serves no HTTP
  (decision 98), which also removes an existing Service's port; memory, CPU and replicas default to 256 MB, 250
  millicores and 1. An existing one gets what differs, and flags left out
  keep what it has. Either way the tag is resolved again, so every deploy
  runs what the tag points at now, pinned by digest. Then it waits until the
  Service is running (up to 5 minutes), unless `--no-wait`. The registry
  password comes from stdin.
- `oup service list`, `oup service show <name>` (JSON),
  `oup service delete <name>` (refused while a Route serves it).
- `oup service logs <name> [--tail <n>] [-f | --follow] [--timestamps]`:
  the last lines (100 by default) of every replica, sorted by time, each
  with the end of its pod's name in brackets, and `previous` for what a
  container wrote before it crashed and restarted; `--tail 0` shows only
  new lines. `-f` goes on with new
  lines as they are written, including from replicas a deploy starts, for
  up to an hour. Nothing is kept (decision 21): what a pod wrote before it
  was replaced is gone.
- `oup job deploy <name> --image <ref> [--schedule <cron> | --no-schedule]
  [--time-zone <IANA name>] [--timeout <seconds>] [--memory <MB>]
  [--cpu <millicores>] [--site hetzner-fsn1|ovh-lim] [--registry-user <user>
  --registry-password-stdin] [--no-wait] [--no-command | -- <command>
  <arg>…]`: brings the
  Job to what the flags say, as `oup service deploy` does for a Service
  (ARCHITECTURE.md, decision 95). What follows `--` replaces the image's
  entrypoint; without it the Job keeps its command (the image's on
  creation), and `--no-command` goes back to the image's. A flag another
  verb takes is refused, not ignored. A Job with `--schedule` is a Cron job; `--no-schedule` makes it
  run only when started. Memory and CPU default to 256 MB and 250
  millicores, the timeout to an hour. Then it waits until the Job is ready
  to run (up to 2 minutes), unless `--no-wait`.
- `oup job run <name> [--env NAME=value]… [--no-wait] [-- <arg>…]`: starts a
  One-off job, with the args after `--` instead of the Job's and the
  variables added to its environment, and waits until it has finished:
  exit 0 when it succeeded, 1 when it failed or timed out, so a CI step
  (a migration) fails with it; a run stopped meanwhile ends the wait at
  once. `--no-wait` prints the run's id and returns.
- `oup job list`, `oup job show <name>` (JSON), `oup job runs <name>` (the
  last day's runs, scheduled and started, newest first), `oup job stop
  <name> <run>` (stops and removes a run), `oup job delete <name>` (and
  its runs).
- `oup job logs <name> [<run>] [--tail <n>] [-f | --follow] [--timestamps]`:
  a run's output, the newest run's without `<run>`; `-f` ends once the run
  has finished. Runs, and so their output, are kept a day.
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
(`planServiceDeploy` is pure), `src/jobs.ts` the Job deploy and runs
(`planJobDeploy` is pure), `src/wait.ts` the polling both wait with and
`src/stdin.ts` reading secret values.
