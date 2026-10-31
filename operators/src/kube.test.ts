import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { KubeConfig } from '@kubernetes/client-node';
import { kubeFrom, toClientModel } from './kube.js';
import { networkPolicyFor } from './kubernetes.js';

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

test("what is sent is the object as written: a NetworkPolicy keeps its peers", async () => {
    const bodies: unknown[] = [];
    const recording = createServer((req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => (body += chunk.toString()));
        req.on('end', () => {
            res.writeHead(200, { 'content-type': 'application/json' });
            if (req.method === 'GET') {
                // The client asks for the resource's name first (discovery).
                res.end(JSON.stringify({ kind: 'APIResourceList', groupVersion: 'networking.k8s.io/v1', resources: [{ kind: 'NetworkPolicy', name: 'networkpolicies', namespaced: true, verbs: ['patch'] }] }));
                return;
            }
            bodies.push(JSON.parse(body));
            res.end(body);
        });
    });
    await new Promise<void>((resolve) => recording.listen(0, resolve));
    const config = new KubeConfig();
    config.loadFromOptions({
        clusters: [{ name: 'c', server: `http://127.0.0.1:${(recording.address() as AddressInfo).port}`, skipTLSVerify: true }],
        users: [{ name: 'u', token: 't' }],
        contexts: [{ name: 'c', cluster: 'c', user: 'u' }],
        currentContext: 'c',
    });
    const policy = networkPolicyFor('11111111-1111-4111-8111-111111111111');
    const applied = await kubeFrom(config).apply(policy, { dryRun: false });
    recording.closeAllConnections();
    recording.close();
    assert.ok(applied.ok);
    assert.deepEqual(bodies, [policy]);
});

test('kinds without a model in the client pass through unchanged', () => {
    const cluster = { apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster', metadata: { name: 'db-x', namespace: 'p' }, spec: { instances: 2 } };
    assert.deepEqual(JSON.parse(JSON.stringify(toClientModel(cluster))), cluster);
});
