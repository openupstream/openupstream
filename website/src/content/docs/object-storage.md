---
title: Object storage
description: S3-compatible object storage hosted in Germany. Every object is stored in three sites, and reads and writes keep working when one site is down.
---

A Bucket is an S3-compatible container for objects. Every object is stored
once in each of three sites, at three hosting providers in Germany.

## What you get

- **Three copies in three sites.** Reads and writes need two of the three,
  so they keep working while any one site is down.
- **The S3 API.** Any S3 client works, such as the AWS SDKs, `aws s3`,
  `rclone` and `s3cmd`.
- **A hostname and a key per Bucket.** A Bucket is reached at
  `<bucket>.s3.openupstream.app`, with an access key that reads and writes
  this Bucket and no other.
- **Static sites.** A Bucket can be served at a domain. See
  [Static sites](/static-sites/).

## What to know before you use it

- **Bucket names are unique across all customers**, since the name is part
  of the hostname.
- **Virtual-hosted style only.** The Bucket is in the hostname, not in the
  path.
- **A single request must finish within 60 seconds.** Upload large files in
  parts, which S3 clients do by default.
- **No event notifications** when an object changes.
- **Deleting a Bucket deletes its objects.** Nothing is kept, unlike a
  Database's backups.
- **A Bucket is private** unless you serve it as a static site.

## Billing

By storage (GB-hours of what you stored) and egress (GB sent to the
internet). The copies in the other sites are included in the unit price.

## How to use it

Create a Bucket in the dashboard or through the API, then point any S3
client at its endpoint with its key. The [Buckets guide](/docs/buckets/) shows how.
