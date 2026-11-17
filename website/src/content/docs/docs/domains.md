---
title: Domains and Routes
description: Use a Project's default hostname, add a custom domain with a TXT record and a CNAME, and route path prefixes to Buckets and Services.
---

A **Domain** is a hostname that serves a Project. A **Route** sends
everything below a path prefix of a Domain to a Bucket or a Service of the
same Project. Domains and Routes are managed on the dashboard's Project
page, with `oup domain` and `oup route`
([command line reference](/docs/reference/cli/)), or through the API, shown
here with the [SDK](/docs/reference/sdk/) next to the commands.

## The default hostname

Every Project has a Domain from the start:
`<project>-<random>.openupstream.app`, with a certificate. It goes only
with its Project.

## Add a custom domain

1. Claim the hostname, with `oup domain add www.example.com` or:

   ```ts
   const domain = await client.createDomain(projectId, { hostname: 'www.example.com' });
   ```

   The answer names a TXT record and its value.

2. Publish that TXT record at `_openupstream.www.example.com`, and a CNAME
   from `www.example.com` to `ingress.openupstream.app`.

3. Ask for verification, with `oup domain verify www.example.com` or:

   ```ts
   if (domain.ok) {
       await client.verifyDomain(projectId, domain.value.id);
   }
   ```

   The record is looked up once, now. A missing record is remembered for up
   to 30 seconds, so a verification right after publishing may need a
   second try.

4. Add a Route. The Domain gets its certificate with its first Route.

Things to know:

- The CNAME has to be in place before the first Route. After a failed
  attempt, the next try for a certificate comes an hour later; deleting the
  Route and adding it again starts over.
- The apex of a domain (`example.com`) cannot be a CNAME. Use your DNS
  provider's CNAME flattening (ALIAS or ANAME), or serve `www` and redirect
  the apex to it. Do not copy the addresses into your zone: they change
  when a Site fails.
- A claim does not reserve a hostname. Whoever publishes the proof first
  gets it.
- Once verified, the proof is not checked again, so you may remove the TXT
  record.

## Routes

```sh
oup route add www.example.com --bucket my-site --spa
oup route add www.example.com/api --service api
oup route add /docs --bucket my-docs
```

An address is the hostname with the path; a path alone, as in the last
line, means the Project's default Domain. The same through the API:

```ts
await client.createRoute(projectId, domainId, { pathPrefix: '/', bucketId, spaFallback: true });
await client.createRoute(projectId, domainId, { pathPrefix: '/api', serviceId });
```

- A path prefix is `/` or `/segment/segment`, without a trailing slash, and
  unique per Domain.
- The longest prefix wins.
- A Service gets the path as it came, prefix included. For a Bucket the
  prefix is stripped.
- A Bucket or Service that a Route targets cannot be deleted.
- Deleting a custom domain deletes its Routes.

A frontend with its API on one hostname is two Routes, as above: no CORS
and no second certificate.

## TLS and HTTP

- Certificates are issued and renewed automatically.
- Port 80 redirects to HTTPS.
- Responses are compressed with gzip, brotli or zstd.
- When a container of a Service does not answer, `GET` and `HEAD` requests
  are tried on another one. Other methods are not sent twice.
