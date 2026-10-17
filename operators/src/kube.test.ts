import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { KubeConfig } from '@kubernetes/client-node';
import { kubeFrom } from './kube.js';

/** An API server that accepts connections and never answers, like one in a Site that just went dark. */
let server: Server;
let kubeConfig: KubeConfig;

before(async () => {
    server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, resolve));
    kubeConfig = new KubeConfig();
    kubeConfig.loadFromOptions({
        clusters: [{ name: 'c', server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, skipTLSVerify: true }],
        users: [{ name: 'u', token: 't' }],
        contexts: [{ name: 'c', cluster: 'c', user: 'u' }],
        currentContext: 'c',
    });
});

after(() => {
    server.closeAllConnections();
    server.close();
});

test('a call the API server never answers ends as an error, not a hang', async () => {
    const kube = kubeFrom(kubeConfig, { timeoutMs: 100 });
    const started = Date.now();
    assert.deepEqual(await kube.readSecret('openupstream-system', 'backup-s3'), {
        ok: false,
        error: { status: 0, message: 'no answer within 100 ms' },
    });
    const applied = await kube.apply(
        { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'project-x' } },
        { dryRun: true },
    );
    assert.equal(applied.ok, false);
    assert.ok(Date.now() - started < 2_000);
});
