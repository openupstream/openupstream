import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Site } from '@openupstream/sdk';
import { bytesOf } from '../kube.js';
import { GiB, roomForGrowth, roomForNew } from './capacity.js';

const siteOf = new Map<string, Site>([
    ['fsn-a', 'hetzner-fsn1'],
    ['fsn-b', 'hetzner-fsn1'],
    ['lim-a', 'ovh-lim'],
]);

test('a new Database needs room in each compute Site, on the roomiest node there', () => {
    const room = new Map([
        ['fsn-a', 5 * GiB],
        ['fsn-b', 20 * GiB],
        ['lim-a', 15.5 * GiB],
    ]);
    assert.equal(roomForNew(room, siteOf, 15 * GiB).ok, true);
    assert.deepEqual(roomForNew(room, siteOf, 16 * GiB), { ok: false, error: { largest: 15.5 * GiB } }, 'ovh-lim is the limit');
    assert.deepEqual(roomForNew(new Map([['fsn-b', 20 * GiB]]), siteOf, 1), { ok: false, error: { largest: 0 } }, 'no node in ovh-lim');
});

test('a grow needs the extra room on every node holding an instance', () => {
    const room = new Map([
        ['fsn-a', 10 * GiB],
        ['lim-a', 4 * GiB],
    ]);
    assert.equal(roomForGrowth(room, ['fsn-a', 'lim-a'], 4 * GiB).ok, true);
    assert.deepEqual(roomForGrowth(room, ['fsn-a', 'lim-a'], 5 * GiB), { ok: false, error: { largest: 4 * GiB } });
    assert.deepEqual(roomForGrowth(room, ['fsn-a', 'gone'], 1), { ok: false, error: { largest: 0 } }, 'a node without a figure');
});

test('quantities as TopoLVM and the kubelet write them', () => {
    assert.equal(bytesOf('15356Mi'), 15356 * 1024 ** 2);
    assert.equal(bytesOf('16114452Ki'), 16114452 * 1024);
    assert.equal(bytesOf('30Gi'), 30 * GiB);
    assert.equal(bytesOf('1000'), 1000);
    assert.equal(bytesOf('1.5Gi'), undefined);
});
