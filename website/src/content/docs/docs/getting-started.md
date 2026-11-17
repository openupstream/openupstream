---
title: Getting started
description: Install oup, create a Project, a Database and a Service, and serve it at the Project's default hostname.
---

This guide takes you from signing in to a Service that runs with a
Database. You need Node.js and a container image in a registry.

## Install oup and sign in

```sh
npm i -g @openupstream/cli
oup login
```

`oup login` opens a page in your browser to approve the sign-in. Over SSH,
`oup login --no-browser` prints a URL and a code to open on any device.

An Account needs a payment method before its first Database, Bucket or
Service. Projects themselves are free.

## Create a Project

```sh
oup project create shop --link
```

A Project holds everything that belongs together and is deleted together.
`--link` writes the Project's id to `.openupstream.json` in this directory,
so the commands below know which Project they act on. The file holds no
secret and may be committed.

## Create a Database

```sh
oup pg create main --memory 512 --storage 10
```

The command waits until both instances are ready, the primary in
Falkenstein and the standby in the Frankfurt region.

## Deploy a Service

```sh
oup service deploy api --image ghcr.io/acme/api:v3 --port 8080
```

The container finds the Database in the environment variable
`DATABASE_URL`. The command waits until the Service is running.

## Add a Secret

```sh
printf %s "$STRIPE_KEY" | oup secret set STRIPE_KEY
```

The value comes from stdin, so it does not end up in your shell's history.
The Service restarts with the new variable.

## Serve it

Every Project has a default hostname,
`<project>-<random>.openupstream.app`, with a certificate. A Route sends a
path prefix of it to a Service or a Bucket. Add a Route for `/` to the
Service on the dashboard's Project page, or through the API; see
[Domains and Routes](/docs/domains/).

## Read its logs

```sh
oup service logs api --follow
```

## Next

- [Databases](/docs/databases/): connecting, resizing and restoring
- [Services](/docs/services/): replicas, private registries and workers
- [Static sites](/docs/static-sites/): a frontend next to the Service
