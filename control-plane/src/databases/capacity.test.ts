import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Site } from '@openupstream/sdk';
import { bytesOf } from '../kube.js';
import { GiB, MiB, databaseMemoryRoom, roomForGrowth, roomForNew } from './capacity.js';

const siteOf = new Map<string, Site>([
    ['fsn-a', 'hetzner-fsn1'],
    ['fsn-b', 'hetzner-fsn1'],
    ['lim-a', 'ovh-lim'],
]);

test('a new Database needs room in its Home site and in one other compute Site, on the roomiest node there', () => {
    const room = new Map([
        ['fsn-a', 5 * GiB],
        ['fsn-b', 20 * GiB],
        ['lim-a', 15.5 * GiB],
    ]);
    assert.equal(roomForNew(room, siteOf, 'hetzner-fsn1', 15 * GiB).ok, true);
    assert.deepEqual(roomForNew(room, siteOf, 'hetzner-fsn1', 16 * GiB), { ok: false, error: { largest: 15.5 * GiB } }, 'ovh-lim is the limit');
    assert.deepEqual(roomForNew(room, siteOf, 'ovh-lim', 16 * GiB), { ok: false, error: { largest: 15.5 * GiB } }, 'the Home site is the limit');
    assert.deepEqual(roomForNew(new Map([['fsn-b', 20 * GiB]]), siteOf, 'hetzner-fsn1', 1), { ok: false, error: { largest: 0 } }, 'no room in ovh-lim');
});

test('with three compute Sites, the standby takes the roomiest other one', () => {
    const three = new Map<string, Site>([...siteOf, ['nbg-a', 'home-c']]);
    const room = new Map([
        ['fsn-a', 30 * GiB],
        ['lim-a', 2 * GiB],
        ['nbg-a', 25 * GiB],
    ]);
    assert.equal(roomForNew(room, three, 'hetzner-fsn1', 25 * GiB).ok, true);
    assert.deepEqual(roomForNew(room, three, 'ovh-lim', 3 * GiB), { ok: false, error: { largest: 2 * GiB } });
    assert.deepEqual(roomForNew(room, new Map([['fsn-a', 'hetzner-fsn1']]), 'hetzner-fsn1', 1), { ok: false, error: { largest: 0 } }, 'no other compute Site');
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

test("the CPU left on a node caps the memory a Database can take there: 250m per GiB", () => {
    assert.equal(databaseMemoryRoom({ memoryBytes: 2 * GiB, cpuMillicores: 4000 }), 2 * GiB, 'memory binds');
    assert.equal(databaseMemoryRoom({ memoryBytes: 8 * GiB, cpuMillicores: 500 }), 2 * GiB, 'CPU binds');
    assert.equal(databaseMemoryRoom({ memoryBytes: 8 * GiB, cpuMillicores: 125 }), 512 * MiB, 'an eighth of a core');
    assert.equal(databaseMemoryRoom({ memoryBytes: 8 * GiB, cpuMillicores: -100 }), 0, 'an overcommitted node');
});
