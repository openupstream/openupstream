---
title: Containers
description: Container hosting in Germany. Run your image from any registry as an HTTP service, a worker, a cron job or a one-off job, sandboxed with gVisor.
---

Bring a container image from any registry and run it in one of three ways:

- a **Service** runs continuously, with one or more replicas: an HTTP
  service with a port, or a worker without one
- a **Cron job** runs to completion at the times its schedule names
- a **One-off job** is one run you start yourself, such as a migration

## What you get

- **Two sites.** A Service with two or more replicas is spread over both
  compute sites. A Service with one replica restarts in the other site when
  its own fails.
- **A sandbox per container.** Every container runs under gVisor, and
  every Project is cut off from the others on the network.
- **Pinned images.** A deploy resolves the tag to a digest, so a restart
  runs the same image. Rollouts start the new container before stopping
  the old one, which gets time to finish its requests.
- **Your Databases and Secrets in the environment.** `DATABASE_URL` and
  your Secrets are there when the container starts.
- **Routing and TLS.** A Service is served at a Domain below any path
  prefix, with a certificate.
- **A live log stream** of every replica and every run.

## What to know before you use it

- **No scale to zero, and no autoscaling.** A Service runs the number of
  replicas you set.
- **No image builds, and no registry.** You build and push the image.
- **No persistent disk.** A container may write 2 GiB of scratch data,
  which is gone with the container. Data belongs in a Database or a Bucket.
- **300 Mbit/s per container** in each direction.
- **Logs are not stored.** You see what running containers wrote, and a
  Job's output for a day.
- **A run is never retried**, and a Job runs for 24 hours at most.

## Billing

By memory (GB-hours of the configured size), CPU-seconds as measured and
egress (GB sent to the internet).

## How to use it

```sh
oup service deploy api --image ghcr.io/acme/api:v3 --port 8080
oup job deploy nightly --image ghcr.io/acme/api:v3 --schedule '0 3 * * *' -- node dist/nightly.js
```

The guides for [Services](/docs/services/) and [Jobs](/docs/jobs/) cover
deploying, scaling, private registries and logs.
