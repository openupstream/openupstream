import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Site } from '@openupstream/sdk';
import { bytesOf, roomForGrowth, roomForNew } from './capacity.js';

const GiB = 1024 ** 3;
const siteOf = new Map<string, Site>([
    ['fsn-a', 'hetzner-fsn1'],
    ['fsn-b', 'hetzner-fsn1'],
    ['lim-a', 'ovh-lim'],
]);

test('a new Database needs its size in each compute Site, on the roomiest node there', () => {
    const capacity = new Map([
        ['fsn-a', 5 * GiB],
        ['fsn-b', 20 * GiB],
        ['lim-a', 15.9 * GiB],
    ]);
    assert.equal(roomForNew(capacity, siteOf, 15).ok, true);
    assert.deepEqual(roomForNew(capacity, siteOf, 16), { ok: false, error: { largestGb: 15 } }, 'ovh-lim rounds down to 15');
    assert.deepEqual(roomForNew(new Map([['fsn-b', 20 * GiB]]), siteOf, 1), { ok: false, error: { largestGb: 0 } }, 'no node in ovh-lim');
});

test('a grow needs the extra size on every node holding a volume', () => {
    const capacity = new Map([
        ['fsn-a', 10 * GiB],
        ['lim-a', 4 * GiB],
    ]);
    assert.equal(roomForGrowth(capacity, ['fsn-a', 'lim-a'], 4).ok, true);
    assert.deepEqual(roomForGrowth(capacity, ['fsn-a', 'lim-a'], 5), { ok: false, error: { largestGb: 4 } });
    assert.deepEqual(roomForGrowth(capacity, ['fsn-a', 'gone'], 1), { ok: false, error: { largestGb: 0 } }, 'a node TopoLVM does not report');
});

test('quantities as TopoLVM writes them', () => {
    assert.equal(bytesOf('15356Mi'), 15356 * 1024 ** 2);
    assert.equal(bytesOf('30Gi'), 30 * GiB);
    assert.equal(bytesOf('1000'), 1000);
    assert.equal(bytesOf('1.5Gi'), undefined);
});
