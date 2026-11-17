---
title: Secrets
description: Store values encrypted per Project and hand them to Services and Jobs as environment variables.
---

A Secret is a named value, stored encrypted and handed to a Project's
Services and Jobs as an environment variable.

## Set

```sh
printf %s "$STRIPE_KEY" | oup secret set STRIPE_KEY
```

The value comes from stdin, never from an argument, which shells keep in
their history. Without a pipe, `oup secret set` asks for it and does not
echo what you type. One trailing line break is dropped.

## List and delete

```sh
oup secret list
oup secret delete STRIPE_KEY
```

`oup secret list` shows names only. A value is never returned, not by `oup`
and not by the API.

## How containers get them

- Every Service and Job of the Project has every Secret of the Project in
  its environment.
- Changing a Secret restarts the Project's Services with the new value. A
  Run of a Job reads the Secrets when it starts.
- `DATABASE_URL` and `DATABASE_URL_<NAME>` are set by the platform and win
  over a Secret of the same name.

## Limits

- The name is an environment variable name.
- A value is at most 64 KiB, and a Project's values together at most
  512 KiB.

## How they are stored

Each value is encrypted with a key of its Project (AES-256-GCM), and those
keys are encrypted with a key the platform keeps apart from its database.
