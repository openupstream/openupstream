# cli

`oup` — the openupstream command line tool. Built on `@openupstream/sdk`.

The dashboard shows what is between the two `docs` comments below as its
`/cli` page (`dashboard/src/lib/docs.ts`): paragraphs, one level of list
items, code blocks and inline code only; a test of the dashboard fails on
anything else.

<!-- docs:start -->

```sh
npm i -g @openupstream/cli
oup login
oup project create shop --link
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
- `oup project list`: the Projects of your Accounts, with each one's
  Account and id, and which one is linked in this directory.
- `oup project create <name> [--account <name|id>] [--link]`: a new
  Project in your Account; with several Accounts, `--account` says which.
  `--link` also links this directory to it, as `oup link` does.
- `oup link <project>`: the Project the commands below act on, by name
  (or id, when two of your Accounts have one of that name). It writes the
  id to `.openupstream.json` in this directory; commands in it or below
  find it, as git finds `.git`. It holds no secret and may be committed.
  `--project <name|id>`, or `OUP_PROJECT` in CI, names another Project for
  one command.
- `oup member list [--account <name|id>]`: the Members of your Account
  with their roles (decision 138) and grants: an `owner` may do everything, the
  Account's Members included; a `developer` every Project and everything
  in it. With several Accounts, `--account` says which, as for every
  `oup member` command.
- `oup member role <email> owner|developer|none`: gives a Member another
  role, or none, which leaves them only their grants; their Postgres roles
  beyond those are dropped. Owners only; an Account always keeps an owner.
- `oup member grant <email> read|write|owner --database <name> [--project <name|id>]`:
  lets a Member use one Database of the linked Project at that level or
  below (decision 139): they see it and its Project's name and open
  `oup pg proxy`, nothing else of the Project. Run again with another
  level to change it; a lower one drops their Postgres roles above it.
  Owners only. A grant counts only while the Member has no role.
- `oup member revoke <email> --database <name> [--project <name|id>]`:
  takes the grant away, and with it their Postgres roles there.
- `oup member remove <email>`: removes a Member, owners only. Their
  Postgres roles from `oup pg proxy`, and those of their API keys, are
  dropped from the Account's Databases (decision 143). Where they had
  `owner`, every open `oup pg proxy` connection to that Project is closed
  once, so theirs ends too; tools reconnect.
- `oup member leave`: leaves the Account; its last owner cannot. `oup
  member` changes need `oup login`: an API key cannot change who is in an
  Account.
- `oup pg create <name> [--memory <MB>] [--storage <GB>] [--site hetzner-fsn1|ovh-lim] [--max-storage <GB> | --no-auto-grow] [--no-wait]`:
  a Database with its primary in the Site (default `hetzner-fsn1`) and a
  standby in the other one, 256 MB and 1 GB unless told otherwise. Its
  storage grows by half once 90% full (decision 111), without a limit
  unless `--max-storage` sets one; `--no-auto-grow` leaves growing to
  `oup pg resize`. It waits
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
- `oup pg resize <name> [--memory <MB>] [--storage <GB>] [--max-storage <GB> | --no-max-storage] [--auto-grow | --no-auto-grow] [--no-wait]`:
  storage only grows, online; a new memory size restarts the two instances
  one after the other, the standby first (writes pause for seconds). Waits
  until the Database is ready again, unless `--no-wait`; a change of the
  growth settings alone takes effect at once.
- `oup pg list` (with each Database's growth: `auto`, `auto ≤ 40 GB` or
  `manual`), `oup pg show <name>` (JSON), `oup pg delete <name>`.
- `oup pg proxy <name> [--access read|write|owner] [--port <n>]`: the
  Database on this machine while it runs (decision 126). It listens on
  `127.0.0.1:5432`, or `--port`, and prints the URL to give `psql`, a
  database GUI or a migration tool. You log in with a Postgres role of
  your own, created the first time (the first start waits a minute or two
  for it): `--access read`, the default, reads every table; `write` also
  inserts, updates and deletes rows; `owner` acts as `app`, the role the
  Project's Services use, so migrations work and what they create belongs
  to `app`. `read` and `write` go through the Pooler like a Service;
  `owner` goes to the primary, so migration tools' locks work, with at most
  5 connections at once, which end when the primary restarts. The same role
  and password every time, on any machine. Connections travel through a
  WebSocket on port 443; nothing else needs installing or opening. With
  `OUP_API_KEY` (which needs `openupstream:write`), the key gets roles of
  its own.
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
- `oup bucket list`, `oup bucket create <name>`, `oup bucket show <name>`
  (S3 endpoint, region and access key id), `oup bucket delete <name>` (and
  every object in it; refused while a Route serves it). A Bucket's name is
  part of its hostname, so no other Bucket of anyone has it.
- `oup bucket show-access-key <name>` prints the Bucket's access key id
  and its secret access key: the only command that prints a secret.
- `oup bucket export-env <name> [--file <path>]` writes what an S3 client
  reads into an env file, `.env` by default, without showing the secret:
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`,
  `AWS_DEFAULT_REGION`, `AWS_ENDPOINT_URL_S3` and `BUCKET_NAME`. Lines that
  set them already are replaced and the rest of the file stays; a new file
  can be read by you alone. Keep it out of git. A file holds one Bucket's
  variables: for a second Bucket, name another file with `--file`. Recent AWS SDKs read all
  but `BUCKET_NAME` by themselves; the AWS CLI also needs
  `aws configure set default.s3.addressing_style virtual`, since a Bucket
  is reached at its own hostname only.
- `oup domain list`, `oup domain add <hostname>`, `oup domain verify
  <hostname>`, `oup domain delete <hostname>` (and its Routes). Every
  Project has its default Domain. `add` claims a hostname of your own and
  prints the two DNS records to publish: a TXT record that proves it is
  yours, and a CNAME that brings its traffic here. `verify` looks the TXT
  record up now. Publish the CNAME before the first Route: the Domain's
  certificate is requested then, and a failed attempt is tried again only
  after an hour.
- `oup route list`, `oup route add <address> --bucket <name> [--spa]`,
  `oup route add <address> --service <name>`, `oup route delete <address>`.
  A Route sends everything below a path of a Domain to a Bucket or to a
  Service that has a port. The address is the hostname with the path, as in
  `www.example.com/docs` (`www.example.com` alone is its `/`), or the path
  alone, as in `/docs`, on the Project's default Domain. A Bucket gets the
  path without the prefix, and with `--spa` a path without an object
  serves `index.html`; a Service gets the path as it came. Deleting a Route
  leaves what it went to.
- `oup usage [--instances] [--json]`: what the Project's Resources use
  now of what they were given: CPU (the last two minutes' average), memory
  and storage per Database, Service, Job and Bucket. `--instances` adds
  every running copy below its Resource, with its Site, its state and its
  restarts; `--json` prints what the API answers. This is the use right
  now, not what is billed.
- `oup site deploy <dir> --bucket <name> [--keep] [--force]`: makes the
  Bucket mirror the directory (decision 88): changed files only, `index.html`
  files last, then deletes what the directory no longer has, unless
  `--keep`. `--force` uploads every file, which also rewrites the headers
  of objects another S3 client uploaded. Cache
  headers come from the name: hashed assets a year and immutable,
  `index.html` `no-cache`, the rest five minutes.

In CI, set `OUP_API_KEY` to a madAuth API key instead of signing in, and
`OUP_API_URL` for another API than `https://console.openupstream.com/api`.

<!-- docs:end -->

`src/oidc.ts` is the device grant and refresh, `src/session.ts` the token
for each call, `src/proxy.ts` the database proxy, `src/deploy.ts` the site deploy (`planDeploy` is pure),
`src/project.ts` the linked Project, `src/services.ts` the Service deploy
(`planServiceDeploy` is pure), `src/jobs.ts` the Job deploy and runs
(`planJobDeploy` is pure), `src/wait.ts` the polling both wait with and
`src/stdin.ts` reading secret values.

## Releasing

Raise `version` in `package.json` and `CLI_VERSION` in `src/version.ts`
(a test checks they match). When the CLI needs a newer SDK, raise the
range of `@openupstream/sdk` and release the SDK first (sdk/README.md).
Merge, then tag that commit `cli-v<version>` and push the tag; only admins
may. The workflow `.github/workflows/cli-release.yml` waits in the
Environment `npm-release` until a maintainer approves the run on GitHub,
then checks that the tag names the version and that the SDK it needs is
on npm (waiting up to five minutes for its file, which npm serves a little
after it lists a new version), builds, tests, installs the packed CLI and runs `oup version`, and
publishes with npm trusted publishing and provenance (ARCHITECTURE.md,
decision 80).
