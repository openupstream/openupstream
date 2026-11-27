import { test } from 'node:test';
import assert from 'node:assert/strict';
import { millicoresOf, podCpuRequest, podMemoryRequest, quantityIn, stateOf } from './kube.js';

const healthy = { instances: 2, readyInstances: 2, ready: true, memoryMb: 512, storageGb: 5 };
const wanted = { memoryMb: 512, storageGb: 5 };

test('a Database is resizing until its Cluster asks for the sizes of its row', () => {
    assert.equal(stateOf(undefined, wanted), 'provisioning');
    assert.equal(stateOf(healthy, wanted), 'ready');
    assert.equal(stateOf(healthy, { ...wanted, storageGb: 10 }), 'resizing');
    assert.equal(stateOf(healthy, { ...wanted, memoryMb: 1024 }), 'resizing');
    assert.equal(stateOf({ ...healthy, resizingVolumes: 2 }, wanted), 'resizing', 'the spec has the size, a volume is still growing');
    assert.equal(stateOf({ ...healthy, ready: false, readyInstances: 1 }, wanted), 'degraded', 'instances restarting for the new size');
    assert.equal(stateOf({ ...healthy, readyInstances: 0 }, { ...wanted, storageGb: 10 }), 'provisioning');
});

test('sizes the Cluster does not state, or in another form, never read as resizing', () => {
    assert.equal(stateOf({ instances: 2, readyInstances: 2, ready: true }, wanted), 'ready');
    assert.equal(stateOf({ ...healthy, storageGb: quantityIn('5G', 'Gi') }, { ...wanted, storageGb: 10 }), 'ready');
});

test('quantities in the form the operator writes', () => {
    assert.equal(quantityIn('512Mi', 'Mi'), 512);
    assert.equal(quantityIn('10Gi', 'Gi'), 10);
    assert.equal(quantityIn('10Gi', 'Mi'), undefined);
    assert.equal(quantityIn('1.5Gi', 'Gi'), undefined);
    assert.equal(quantityIn(undefined, 'Gi'), undefined);
});

test("a pod's memory request as the scheduler counts it: containers or the largest init container, plus overhead", () => {
    const Mi = 1024 ** 2;
    const container = (memory: string) => ({ name: 'c', resources: { requests: { memory } } });
    assert.equal(podMemoryRequest({ spec: { containers: [container('256Mi'), container('64Mi')] } }), 320 * Mi);
    assert.equal(podMemoryRequest({ spec: { containers: [container('256Mi')], initContainers: [container('512Mi')] } }), 512 * Mi);
    assert.equal(podMemoryRequest({ spec: { containers: [container('256Mi')], overhead: { memory: '64Mi' } } }), 320 * Mi, "gVisor's overhead");
    assert.equal(podMemoryRequest({ spec: { containers: [{ name: 'c' }] } }), 0);
});

test('CPU quantities in millicores', () => {
    assert.equal(millicoresOf('250m'), 250);
    assert.equal(millicoresOf('2'), 2000);
    assert.equal(millicoresOf('0.5'), 500);
    assert.equal(millicoresOf('1Gi'), undefined);
    assert.equal(millicoresOf(''), undefined);
});

test("a pod's CPU request as the scheduler counts it", () => {
    const container = (cpu: string) => ({ name: 'c', resources: { requests: { cpu } } });
    assert.equal(podCpuRequest({ spec: { containers: [container('250m'), container('1')] } }), 1250);
    assert.equal(podCpuRequest({ spec: { containers: [container('100m')], initContainers: [container('500m')], overhead: { cpu: '10m' } } }), 510);
    assert.equal(podCpuRequest({ spec: { containers: [{ name: 'c' }] } }), 0, 'a Database before decision 150');
});
