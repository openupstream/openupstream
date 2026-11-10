import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseDetails } from '@openupstream/sdk';
import { formatDatabases, planRestore } from './databases.js';

const orders: DatabaseDetails = {
    id: '55555555-5555-4555-8555-555555555555',
    projectId: '11111111-1111-4111-8111-111111111111',
    name: 'orders',
    homeSite: 'ovh-lim',
    memoryMb: 1024,
    storageGb: 20,
    createdAt: '2026-11-01T00:00:00Z',
    state: 'ready',
    connection: { host: 'db-x-pooler', port: 5432, database: 'app', user: 'app' },
};

test('a live source by name or id: its size and Home site unless the flags say otherwise', () => {
    assert.deepEqual(planRestore([orders], { source: 'orders', name: 'orders-copy', time: '2026-11-10T09:30:00Z' }), {
        ok: true,
        input: {
            name: 'orders-copy',
            memoryMb: 1024,
            storageGb: 20,
            homeSite: 'ovh-lim',
            restoreFrom: { databaseId: orders.id, targetTime: '2026-11-10T09:30:00Z' },
        },
    });
    const byId = planRestore([orders], { source: orders.id, name: 'copy', storageGb: 40, homeSite: 'hetzner-fsn1' });
    assert.deepEqual(byId, {
        ok: true,
        input: { name: 'copy', memoryMb: 1024, storageGb: 40, homeSite: 'hetzner-fsn1', restoreFrom: { databaseId: orders.id } },
    });
});

test('a deleted source: by its id, with --storage', () => {
    const deletedId = '66666666-6666-4666-8666-666666666666';
    assert.equal(planRestore([orders], { source: 'gone', name: 'copy' }).ok, false);
    assert.equal(planRestore([orders], { source: deletedId, name: 'copy' }).ok, false);
    assert.deepEqual(planRestore([orders], { source: deletedId, name: 'copy', storageGb: 5 }), {
        ok: true,
        input: { name: 'copy', memoryMb: 256, storageGb: 5, restoreFrom: { databaseId: deletedId } },
    });
});

test('--time needs its zone', () => {
    assert.equal(planRestore([orders], { source: 'orders', name: 'copy', time: '2026-11-10 09:30' }).ok, false);
    assert.equal(planRestore([orders], { source: 'orders', name: 'copy', time: '2026-11-10T09:30:00' }).ok, false);
    assert.equal(planRestore([orders], { source: 'orders', name: 'copy', time: '2026-11-10T10:30:00+01:00' }).ok, true);
});

test('the list shows what a Database was restored from', () => {
    const [line] = formatDatabases([{ ...orders, restoredFrom: { databaseId: 'abc', targetTime: '2026-11-10T09:30:00.000Z' } }]);
    assert.match(line ?? '', /^orders\s+ready\s+ovh-lim\s+1024 MB\s+20 GB  restored from abc at 2026-11-10T09:30:00.000Z$/);
});
