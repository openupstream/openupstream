---
title: TypeScript SDK
description: "@openupstream/sdk, the typed TypeScript client for the openupstream API that oup and the dashboard are built on."
---

`@openupstream/sdk` is the typed client for the openupstream API. `oup` and
the dashboard are built on it, so everything they do can be scripted.

```sh
npm i @openupstream/sdk
```

```ts
import { OpenUpstreamClient } from '@openupstream/sdk';

const client = new OpenUpstreamClient({ token: process.env.OPENUPSTREAM_TOKEN! });
const project = await client.createProject({ accountId, name: 'shop-prod' });
if (project.ok) {
    const db = await client.createDatabase(project.value.id, { name: 'orders', memoryMb: 512, storageGb: 10 });
}
```

## Authentication

The token is an Account token (`oup_tok_…`, from `oup token create`) or an
API key. An Account token may do what its role or grants allow, in its own
Account. A key with the scope `openupstream:read` may read everything its
Member may, one with `openupstream:write` may do everything its Member
may. Neither manages the Account's Members or tokens.

## Another installation

The client talks to `https://console.openupstream.com/api`. For an
installation of your own, pass `baseUrl`:
`https://<its platform domain>/api`.

## Results, not exceptions

Every call returns `{ ok: true, value }` or
`{ ok: false, error: { status, message } }`. Nothing throws. A status of 0
means the API was not reached. For a refused request, `message` names each
field the API objected to.

## Calls

| Area | Methods |
| --- | --- |
| Accounts and Projects | `listAccounts`, `createAccount`, `listProjects`, `createProject`, `getProject`, `deleteProject`, `getUsage` |
| Databases | `listDatabases`, `createDatabase`, `getDatabase`, `updateDatabase`, `deleteDatabase` |
| Buckets | `listBuckets`, `createBucket`, `getBucket`, `deleteBucket` |
| Domains and Routes | `listDomains`, `createDomain`, `verifyDomain`, `deleteDomain`, `listRoutes`, `createRoute`, `deleteRoute` |
| Services | `listServices`, `createService`, `getService`, `updateService`, `deployService`, `deleteService`, `serviceLogs` |
| Jobs | `listJobs`, `createJob`, `getJob`, `updateJob`, `deployJob`, `deleteJob`, `startJobRun`, `listJobRuns`, `getJobRun`, `deleteJobRun`, `jobRunLogs` |
| Secrets | `listSecrets`, `putSecret`, `deleteSecret` |

The types of every request and answer come with the package.
