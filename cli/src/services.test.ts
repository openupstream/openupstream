import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServiceDetails, ServiceState } from '@openupstream/sdk';
import { DEFAULTS, formatServices, planServiceDeploy, waitUntilRunning } from './services.js';
import { trimLineBreak } from './stdin.js';

const existing: ServiceDetails = {
    id: '44444444-4444-4444-8444-444444444444',
    projectId: '11111111-1111-4111-8111-111111111111',
    name: 'api',
    image: 'ghcr.io/acme/api:v1',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    deployedAt: '2026-11-01T00:00:00Z',
    replicas: 2,
    memoryMb: 256,
    cpuMillicores: 250,
    port: 8080,
    homeSite: null,
    registryAuth: false,
    createdAt: '2026-11-01T00:00:00Z',
    state: 'running',
};

test('a new Service is created with the defaults for what the flags leave out; it needs a port', () => {
    assert.deepEqual(planServiceDeploy(undefined, { name: 'api', image: 'nginx', port: 80 }), {
        kind: 'create',
        input: { name: 'api', image: 'nginx', port: 80, ...DEFAULTS },
    });
    assert.equal(planServiceDeploy(undefined, { name: 'api', image: 'nginx' }).kind, 'invalid');
});

test('the same settings deploy the tag again; flags left out keep what the Service has', () => {
    assert.deepEqual(planServiceDeploy(existing, { name: 'api', image: 'ghcr.io/acme/api:v1' }), { kind: 'redeploy', serviceId: existing.id });
    assert.deepEqual(planServiceDeploy(existing, { name: 'api', image: 'ghcr.io/acme/api:v1', port: 8080, replicas: 2 }), {
        kind: 'redeploy',
        serviceId: existing.id,
    });
});

test('a change sends only what differs, always with the image, so the tag is resolved again', () => {
    assert.deepEqual(planServiceDeploy(existing, { name: 'api', image: 'ghcr.io/acme/api:v1', replicas: 3, memoryMb: 256 }), {
        kind: 'update',
        serviceId: existing.id,
        patch: { replicas: 3, image: 'ghcr.io/acme/api:v1' },
    });
    assert.deepEqual(planServiceDeploy(existing, { name: 'api', image: 'ghcr.io/acme/api:v2', homeSite: 'ovh-lim' }), {
        kind: 'update',
        serviceId: existing.id,
        patch: { homeSite: 'ovh-lim', image: 'ghcr.io/acme/api:v2' },
    });
    const auth = { username: 'ci', password: 'token' };
    assert.deepEqual(planServiceDeploy(existing, { name: 'api', image: 'ghcr.io/acme/api:v1', registryAuth: auth }), {
        kind: 'update',
        serviceId: existing.id,
        patch: { image: 'ghcr.io/acme/api:v1', registryAuth: auth },
    });
});

test('the list shows state, replicas, image and the start of the digest', () => {
    assert.deepEqual(formatServices([existing]), [
        `api                      running     2×  ghcr.io/acme/api:v1 (sha256:aaaaaaaaaaaa)`,
    ]);
});

test('waiting reports each state once and ends when running, or when the time is up', async () => {
    const states: ServiceState[] = ['deploying', 'deploying', 'running'];
    const reported: ServiceState[] = [];
    const reads = [...states];
    const done = await waitUntilRunning(async () => ({ ok: true, value: { ...existing, state: reads.shift() ?? 'running' } }), {
        timeoutMs: 1_000,
        intervalMs: 1,
        report: (state) => reported.push(state),
    });
    assert.deepEqual(done, { ok: true });
    assert.deepEqual(reported, ['deploying', 'running']);
    const stuck = await waitUntilRunning(async () => ({ ok: true, value: { ...existing, state: 'deploying' } }), {
        timeoutMs: 20,
        intervalMs: 5,
        report: () => undefined,
    });
    assert.equal(stuck.ok, false);
});

test("a piped value loses one trailing line break, as echo adds it, and nothing else", () => {
    assert.equal(trimLineBreak('s3cr3t\n'), 's3cr3t');
    assert.equal(trimLineBreak('s3cr3t\r\n'), 's3cr3t');
    assert.equal(trimLineBreak('s3cr3t\n\n'), 's3cr3t\n');
    assert.equal(trimLineBreak(' spaced '), ' spaced ');
});
