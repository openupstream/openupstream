import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quantityIn, stateOf } from './kube.js';

const healthy = { instances: 2, readyInstances: 2, ready: true, memoryMb: 512, storageGb: 5 };
const wanted = { memoryMb: 512, storageGb: 5 };

test('a Database is resizing until its Cluster asks for the sizes of its row', () => {
    assert.equal(stateOf(undefined, wanted), 'provisioning');
    assert.equal(stateOf(healthy, wanted), 'ready');
    assert.equal(stateOf(healthy, { ...wanted, storageGb: 10 }), 'resizing');
    assert.equal(stateOf(healthy, { ...wanted, memoryMb: 1024 }), 'resizing');
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
