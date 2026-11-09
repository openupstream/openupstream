import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { V1Node } from '@kubernetes/client-node';
import { setTimeout as sleep } from 'node:timers/promises';
import { type NodeWatch, addressesOf, nodeBlocks, nodeChanges, readNodeBlocks, watchNodes } from './nodes.js';
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

/** A Watch that answers each open with `script(open number)`: events to send, then how the watch ends. */
const fakeWatch = (script: (open: number) => { events: [string, unknown][]; end: unknown }) => {
    const opens: number[] = [];
    const controllers: AbortController[] = [];
    const watch: NodeWatch = {
        watch: async (_path, _query, callback, done) => {
            opens.push(Date.now());
            const { events, end } = script(opens.length);
            for (const [phase, node] of events) {
                callback(phase, node);
            }
            const controller = new AbortController();
            controllers.push(controller);
            queueMicrotask(() => done(end));
            return controller;
        },
    };
    return { watch, opens, controllers };
};

const node = (address: string) => ({ metadata: { name: 'fsn1' }, status: { addresses: [{ type: 'InternalIP', address }] } });

test('the watch wakes on a changed address, and a watch the server closes at once is not reopened in a tight loop', async () => {
    const stop = new AbortController();
    const { watch, opens } = fakeWatch((open) => ({ events: [['ADDED', node(open < 3 ? '198.51.100.1' : '198.51.100.9')]], end: null }));
    let wakes = 0;
    watchNodes(watch, () => (wakes += 1), () => undefined, stop.signal, { reopenMs: 30, retryMs: 1_000 });
    await sleep(100);
    stop.abort();
    // Opened at 0, 30, 60, 90 ms: the replayed Node woke nothing, its new address did.
    assert.ok(opens.length >= 3 && opens.length <= 5, `${opens.length} opens`);
    assert.equal(wakes, 2);
});

test('after an error the watch waits longer, logs it, and stopping aborts the watch running', async () => {
    const stop = new AbortController();
    const { watch, opens, controllers } = fakeWatch((open) => ({ events: [], end: open === 1 ? new Error('Forbidden') : null }));
    const logs: Record<string, unknown>[] = [];
    watchNodes(watch, () => undefined, (entry) => logs.push(entry), stop.signal, { reopenMs: 1_000, retryMs: 40 });
    await sleep(20);
    assert.equal(opens.length, 1);
    await sleep(40);
    assert.equal(opens.length, 2);
    assert.deepEqual(logs, [{ msg: 'node watch failed, retrying', error: 'Forbidden' }]);
    stop.abort();
    assert.equal(controllers.at(-1)?.signal.aborted, true);
    await sleep(1_050);
    assert.equal(opens.length, 2);
});
