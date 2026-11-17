---
title: Jobs
description: Run a container image to completion, on a schedule as a Cron job or started yourself as a One-off job, for example a migration in CI.
---

A Job is your container image that runs to completion, with its command,
resources and timeout. With a schedule it is a **Cron job**. Any Job can
also be started as a **One-off job**. One execution is a **Run**.

## Deploy

```sh
oup job deploy nightly --image ghcr.io/acme/api:v3 --schedule '0 3 * * *' --time-zone Europe/Berlin -- node dist/nightly.js
```

What follows `--` replaces the image's entrypoint. Like
`oup service deploy`, the command creates the Job the first time and later
changes what differs.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--image <ref>` | | The image, from any registry. |
| `--schedule <cron>` | | Five cron fields, or `@hourly` to `@yearly`. |
| `--no-schedule` | | The Job only runs when you start it. |
| `--time-zone <IANA name>` | UTC | The zone the schedule is read in. |
| `--timeout <seconds>` | 3600 | A Run is stopped after this long. 24 hours at most. |
| `--memory <MB>` | 256 | Memory of a Run. |
| `--cpu <millicores>` | 250 | CPU of a Run. |
| `--no-command` | | Go back to the image's own entrypoint. |

Private registries work as for a [Service](/docs/services/#private-registries).

## Start a One-off job

```sh
oup job deploy migrate --image ghcr.io/acme/api:v3 -- npm run migrate
oup job run migrate
```

`oup job run` waits until the Run has finished and exits with 0 when it
succeeded and 1 when it failed or timed out, so a CI step fails with it.

```sh
oup job run migrate --env DRY_RUN=1 -- --step 1
```

`--env` adds variables to the Run's environment. The arguments after `--`
replace the Job's arguments and are handed to its command, here
`npm run migrate --step 1`.

## How Runs behave

- A Run is never retried.
- A Cron job does not overlap itself: when the previous Run is still going,
  the due one is skipped.
- A scheduled Run that is more than 5 minutes late is skipped. A Cron job
  does not catch up on what it missed.
- A finished Run and its output are kept for a day. A Cron job keeps its
  last 3 successful and 3 failed scheduled Runs.
- Every Run starts the image digest pinned by the last deploy.
- A Run gets the Project's Secrets and Database URLs like a Service, and
  has the same [limits](/docs/services/#limits).

## Look at Runs

```sh
oup job runs nightly
oup job logs nightly
oup job stop nightly <run>
```

`oup job logs` prints the newest Run's output; name a Run to see another.
