# @openupstream/sdk

Typed TypeScript client for the openupstream API. The CLI and the dashboard are
built on it; customers can use it to script their own account.

API types are defined here first and implemented in `control-plane/`, so this
package doubles as the contract between client and server.

```ts
import { OpenUpstreamClient } from '@openupstream/sdk';

const client = new OpenUpstreamClient({ token: process.env.OPENUPSTREAM_TOKEN! });
const project = await client.createProject({ accountId, name: 'shop-prod' });
if (project.ok) {
    const db = await client.createDatabase(project.value.id, { name: 'orders', memoryMb: 512, storageGb: 10 });
}
```

In a browser on the dashboard's origin the client takes `{ session:
'cookie' }` in place of a token: the browser then sends madAuth's session
cookie with every call (ARCHITECTURE.md, decision 116).

Every call returns `{ ok: true, value }` or `{ ok: false, error: { status, message } }`
(status 0: the API was not reached); nothing throws. For a refused request
`message` also names each field the API objected to, e.g. `invalid request
(name: a DNS label: lowercase letters, digits and hyphens)`. `src/internal.ts` holds
the contract between the control plane and its internal callers (the
operators and the billing service), not for customers.

## Releasing

Raise `version` in `package.json` (and `SDK_VERSION` in `src/index.ts`,
and the range of `@openupstream/sdk` in the other workspaces when the
minor version changes: `^0.1.0` does not match `0.2.0`), merge, then tag that commit `sdk-v<version>` and push the tag; only admins
may. The workflow `.github/workflows/sdk-release.yml` waits in the
Environment `npm-release` until a maintainer approves the run on GitHub,
then checks that the tag names the version, builds, tests and publishes
with npm trusted publishing and provenance: no npm token exists anywhere
(ARCHITECTURE.md, decision 80).
