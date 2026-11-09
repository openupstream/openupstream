import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { V1Node } from '@kubernetes/client-node';
import { addressesOf, nodeBlocks, nodeChanges, readNodeBlocks } from './nodes.js';
import { err, ok } from './result.js';
import { NODES, NODE_BLOCKS } from './testing/nodes.js';

test("a Node's addresses are its IPs, without its hostname, once each and sorted", () => {
    const node: V1Node = {
        metadata: { name: 'lim' },
        status: {
            addresses: [
                { type: 'InternalIP', address: '203.0.113.2' },
                { type: 'Hostname', address: 'lim' },
                { type: 'ExternalIP', address: '203.0.113.2' },
                { type: 'InternalIP', address: '2001:db8::2' },
            ],
        },
    };
    assert.deepEqual(addressesOf(node), { name: 'lim', addresses: ['2001:db8::2', '203.0.113.2'] });
    assert.deepEqual(addressesOf({ metadata: { name: 'new' } }), { name: 'new', addresses: [] });
});

test('the blocks hold every Node address, IPv4 as /32 and IPv6 as /128', () => {
    assert.deepEqual(nodeBlocks(NODES), ok(NODE_BLOCKS));
});

test('no Nodes, or a Node without an address, is an error: it would leave a node out of the policy', () => {
    assert.deepEqual(nodeBlocks([]), err('no Nodes listed'));
    assert.deepEqual(nodeBlocks([...NODES, { name: 'new', addresses: [] }]), err('Nodes without an IP address: new'));
});

test('a failed listing is the error of the blocks', async () => {
    const failed = await readNodeBlocks(async () => err({ status: 403, message: 'forbidden' }));
    assert.deepEqual(failed, err({ status: 403, message: 'forbidden' }));
    assert.deepEqual(await readNodeBlocks(async () => ok([...NODES])), ok(NODE_BLOCKS));
});

test("a watch event counts only when a Node joins, goes or changes its addresses", () => {
    const changed = nodeChanges();
    const fsn1 = { name: 'fsn1', addresses: ['198.51.100.1'] };
    assert.equal(changed('ADDED', fsn1), true);
    // A status update every few seconds, and a reconnect replaying the Node.
    assert.equal(changed('MODIFIED', fsn1), false);
    assert.equal(changed('ADDED', fsn1), false);
    assert.equal(changed('MODIFIED', { name: 'fsn1', addresses: ['198.51.100.9'] }), true);
    assert.equal(changed('BOOKMARK', { name: '', addresses: [] }), false);
    assert.equal(changed('DELETED', fsn1), true);
    assert.equal(changed('DELETED', fsn1), false);
});
