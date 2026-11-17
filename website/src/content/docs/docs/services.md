---
title: Services
description: Deploy a container image as a Service, scale it, pull from a private registry, run a worker without a port, and know how rollouts and restarts behave.
---

A Service is your container image running continuously, with one or more
replicas. What it offers and what it leaves out is on the
[Containers product page](/containers/).

## Deploy

```sh
oup service deploy api --image ghcr.io/acme/api:v3 --port 8080
```

`oup service deploy` brings the Service to what the flags say. It creates
the Service the first time; later it changes what differs, and flags you
leave out keep what the Service has.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--image <ref>` | | The image, from any registry. Without a tag it means `latest`. |
| `--port <n>` | | The port your container listens on for HTTP. |
| `--no-port` | | A worker that serves no HTTP. |
| `--replicas <n>` | 1 | How many containers run. |
| `--memory <MB>` | 256 | Memory of each replica. |
| `--cpu <millicores>` | 250 | CPU of each replica. |
| `--site hetzner-fsn1\|ovh-lim` | | Where a single replica runs. |
| `--no-wait` | | Return before the Service is running. |

A new Service needs `--port` or `--no-port`. The dashboard's Project page
deploys Services too, from public images.

## Images and rollouts

- Every deploy resolves the tag again and pins the digest it points at.
  Restarts and scaling run that same image, also when the tag has moved.
  To run what the tag points at now, deploy again.
- An image the registry does not have, or will not serve with your
  credentials, is refused at once and nothing changes.
- A rollout starts the new container before it stops the old one. A new
  container gets requests once its port accepts connections, so open the
  port only when your app is ready to serve.
- An old container gets requests for 5 more seconds, then `SIGTERM`. Stop
  accepting new requests and finish the open ones: it is stopped for good
  120 seconds after the rollout began replacing it. A worker gets the same
  120 seconds to finish its work. A request through a Route is cut after
  60 seconds anyway, rollout or not.
- During a rollout the old and the new version both serve, so a change to
  your Database must work with both.
- A Service is `deploying` until its containers run what you last asked
  for, then `running`, or `degraded` when some of them do not.

### Private registries

```sh
printf %s "$REGISTRY_TOKEN" | oup service deploy api --image ghcr.io/acme/api:v3 --port 8080 --registry-user acme --registry-password-stdin
```

The password comes from stdin. It is stored encrypted and never returned.
Credentials are sent to their own registry only; a new image at another
registry drops them.

## Replicas and Sites

- With two or more replicas, the Service is spread over both compute Sites.
- With one replica, it runs in the Home site of the Project's oldest
  Database, or in the Site you name, and restarts in the other Site when
  its own fails.
- There is no autoscaling and no scale to zero.

## Environment

A container gets, as environment variables:

- the Project's [Secrets](/docs/secrets/)
- `DATABASE_URL` and `DATABASE_URL_<NAME>` for the Project's
  [Databases](/docs/databases/)

Changing a Secret, or adding or deleting a Database, restarts the Service
with the new values.

## Workers

A Service without a port is a worker, such as a consumer of a queue in
Postgres:

```sh
oup service deploy worker --image ghcr.io/acme/api:v3 --no-port
```

A worker cannot be the target of a Route.

## Limits

| What | Limit |
| --- | --- |
| Memory and CPU | What you configured. A container that needs more memory is restarted. |
| Disk | 2 GiB of scratch space per container, gone with the container. |
| Network | 300 Mbit/s per container in each direction, less while its server's uplink is nearly full. |
| Outgoing connections | The internet, the Project's Databases and its Buckets at their public hostnames. No private addresses. |

## Serve it at a Domain

A Route sends a path prefix of a Domain to the Service; see
[Domains and Routes](/docs/domains/). The Service gets the request with
its path as it came, prefix included.

## Delete

```sh
oup service delete api
```

A Service that a Route still serves cannot be deleted; delete the Route
first.
