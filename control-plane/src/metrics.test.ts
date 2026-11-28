import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetricsApp } from './metrics.js';
import { err, ok } from './result.js';
import { sitesOf } from './sites.js';

test('/metrics serves the Site checks as Prometheus text, without series when the nodes cannot be read', async () => {
    const node = { name: 'x', site: undefined, compute: false, default: false, description: undefined, createdAt: '', quorumOnly: false, ready: true };
    const seen = await createMetricsApp(async () => ok(sitesOf([node]))).request('/metrics');
    assert.equal(seen.status, 200);
    assert.equal(seen.headers.get('content-type'), 'text/plain; version=0.0.4');
    assert.match(await seen.text(), /^openupstream_site_problem\{problem="node-without-site",node="x",site=""\} 1$/m);
    const blind = await createMetricsApp(async () => err('forbidden')).request('/metrics');
    assert.doesNotMatch(await blind.text(), /^openupstream_site_nodes /m);
    assert.equal((await createMetricsApp(async () => err('forbidden')).request('/v1/sites')).status, 404);
});
