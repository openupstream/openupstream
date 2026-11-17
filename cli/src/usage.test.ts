import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectUsage } from '@openupstream/sdk';
import { formatBytes, formatCpu, formatMeasured, formatUsage } from './usage.js';

const usage: ProjectUsage = {
    measuredAt: '2026-11-17T12:00:00.000Z',
    measured: true,
    resources: [
        {
            kind: 'database',
            id: 'd1',
            name: 'main',
            cpuMillicores: { used: 12, allocated: null },
            memoryBytes: { used: 80 * 2 ** 20, allocated: 512 * 2 ** 20 },
            storageBytes: { used: 167 * 2 ** 20, allocated: 10 * 2 ** 30 },
            instances: [
                { name: '1', role: 'database', site: 'hetzner-fsn1', state: 'running', restarts: 0, startedAt: null, cpuMillicores: 10, memoryBytes: 80 * 2 ** 20, storageBytes: 167 * 2 ** 20 },
                { name: 'pooler-x', role: 'pooler', site: null, state: 'restarting', restarts: 2, startedAt: null, cpuMillicores: null, memoryBytes: null, storageBytes: null },
            ],
        },
        {
            kind: 'bucket',
            id: 'b1',
            name: 'acme-site',
            cpuMillicores: { used: null, allocated: null },
            memoryBytes: { used: null, allocated: null },
            storageBytes: { used: 2048, allocated: null },
            instances: [],
        },
    ],
};

test('bytes, CPUs, and used of what was given', () => {
    assert.deepEqual([0, 512, 1024, 2 ** 30, 1.5 * 2 ** 30, 250 * 2 ** 30].map(formatBytes), ['0 B', '512 B', '1.0 KB', '1.0 GB', '1.5 GB', '250 GB']);
    assert.equal(formatCpu(130), '0.13 CPU');
    assert.equal(formatMeasured({ used: 1024, allocated: 2048 }, formatBytes), '1.0 KB of 2.0 KB');
    assert.equal(formatMeasured({ used: 1024, allocated: null }, formatBytes), '1.0 KB');
    assert.equal(formatMeasured({ used: null, allocated: 2048 }, formatBytes), '2.0 KB allocated');
    assert.equal(formatMeasured({ used: null, allocated: null }, formatBytes), '-');
});

test('a table of the Resources, columns in line, with when it was measured', () => {
    assert.deepEqual(formatUsage(usage, 'shop', { instances: false }), [
        'KIND      NAME       CPU       MEMORY             STORAGE',
        'Database  main       0.01 CPU  80.0 MB of 512 MB  167 MB of 10.0 GB',
        'Bucket    acme-site  -         -                  2.0 KB',
        '',
        'Measured 2026-11-17T12:00:00.000Z: use now of what was given, not what is billed.',
    ]);
});

test('with instances, every running copy below its Resource', () => {
    assert.deepEqual(formatUsage(usage, 'shop', { instances: true }).slice(0, 5), [
        'KIND      NAME       CPU       MEMORY             STORAGE',
        'Database  main       0.01 CPU  80.0 MB of 512 MB  167 MB of 10.0 GB',
        '    database 1       hetzner-fsn1  running                 0.01 CPU  80.0 MB  167 MB',
        '    pooler pooler-x  not placed    restarting, 2 restarts  -         -        -',
        'Bucket    acme-site  -         -                  2.0 KB',
    ]);
});

test('nothing to show, and nothing measured', () => {
    assert.deepEqual(formatUsage({ ...usage, resources: [] }, 'shop', { instances: false }), ['No Resources in shop.']);
    assert.match(formatUsage({ ...usage, measured: false }, 'shop', { instances: false }).at(-1) ?? '', /not measured right now/);
});
