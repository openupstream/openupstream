---
title: Logs
description: Read and follow what a Service's replicas and a Job's Runs write. Logs are a live stream; nothing is stored.
---

A container's output on stdout and stderr is its log. openupstream shows it
as a live stream and stores nothing: what a container wrote before it was
replaced is gone.

## A Service

```sh
oup service logs api
oup service logs api --follow
```

- Without flags you get the last 100 lines of every replica, sorted by
  time. `--tail <n>` changes the number; `--tail 0` shows only new lines.
- Each line names its replica. Lines marked `previous` are what a
  container wrote before it crashed and restarted.
- `--follow` goes on with new lines, also from replicas a deploy starts,
  for up to an hour.
- `--timestamps` puts the time in front of each line.

## A Job

```sh
oup job logs nightly
oup job logs nightly <run> --follow
```

Without a Run, you get the newest one's output. `--follow` ends when the
Run has finished. Runs, and so their output, are kept for a day.

## Limits

- A snapshot holds at most the newest 4 MiB of lines per container.
- An Account can follow about 10 streams at once.
- A container may write 2 GiB of logs and scratch files together.

## Keep logs

To keep logs, or to alert on them, send them from your application to a
service of your choice.
