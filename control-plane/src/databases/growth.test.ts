import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ControlPlaneKube } from '../kube.js';
import { err, ok } from '../result.js';
import { type TestDatabase, createTestDatabase } from '../testing/postgres.js';
import { GiB } from './capacity.js';
import { type GrowthRow, type PrometheusSample, CAPACITY_QUERY, USED_QUERY, growthPass, planGrowth, prometheusClient, usageOf } from './growth.js';

const row = (overrides: Partial<GrowthRow> = {}): GrowthRow => ({
    id: 'a',
    projectId: 'p',
    name: 'orders',
    storageGb: 10,
    maxStorageGb: null,
    held: false,
    ...overrides,
});
const full = (used: number, sizeGb = 10) => new Map([['a', { used, capacityBytes: sizeGb * GiB * 0.98 }]]);

describe('planGrowth', () => {
    test('90% used grows by half, rounded up; less waits', () => {
        assert.deepEqual(planGrowth([row()], full(0.89)), []);
        assert.deepEqual(planGrowth([row()], full(0.9)), [{ kind: 'grow', row: row(), toGb: 15 }]);
        assert.deepEqual(planGrowth([row({ storageGb: 1 })], full(0.95, 1)), [{ kind: 'grow', row: row({ storageGb: 1 }), toGb: 2 }], 'at least 1 GB');
        assert.deepEqual(planGrowth([row({ storageGb: 3 })], full(0.95, 3)), [{ kind: 'grow', row: row({ storageGb: 3 }), toGb: 5 }]);
    });

    test('never past the maximum; at it, reported', () => {
        assert.deepEqual(planGrowth([row({ maxStorageGb: 12 })], full(0.95)), [{ kind: 'grow', row: row({ maxStorageGb: 12 }), toGb: 12 }]);
        assert.deepEqual(planGrowth([row({ maxStorageGb: 10 })], full(0.95)), [{ kind: 'at-maximum', row: row({ maxStorageGb: 10 }), used: 0.95 }]);
    });

    test('not while held, and not before the last size reached the volume', () => {
        assert.deepEqual(planGrowth([row({ held: true })], full(0.95)), [{ kind: 'held', row: row({ held: true }), used: 0.95 }]);
        assert.deepEqual(planGrowth([row({ storageGb: 15 })], full(0.95, 10)), [], 'the volume is still 10 GB: the growth to 15 is on its way');
        assert.deepEqual(planGrowth([row()], new Map()), [], 'no usage figures');
    });
});

const sample = (pvc: string, value: number): PrometheusSample => ({ labels: { namespace: 'project-x', persistentvolumeclaim: pvc }, value });
const id = '5d1c2a33-90b4-4c8f-8f3e-6c2b9d0e7f44';

test("a Database's usage is its fullest volume, its size its smallest; other PVCs are left out", () => {
    const usage = usageOf(
        [sample(`db-${id}-1`, 0.5), sample(`db-${id}-2`, 0.92), sample('data-garage-0', 0.99), sample(`db-${id}-3`, Number.NaN)],
        [sample(`db-${id}-1`, 10 * GiB), sample(`db-${id}-2`, 9.8 * GiB)],
    );
    assert.deepEqual([...usage], [[id, { used: 0.92, capacityBytes: 9.8 * GiB }]]);
});

test('the Prometheus client reads an instant vector and reports failures', async () => {
    const answer = { status: 'success', data: { resultType: 'vector', result: [{ metric: { persistentvolumeclaim: 'db-x-1' }, value: [1, '0.93'] }] } };
    const seen: string[] = [];
    const fetchOk = (async (url: string | URL | Request) => {
        seen.push(String(url));
        return new Response(JSON.stringify(answer), { status: 200 });
    }) as typeof fetch;
    assert.deepEqual(await prometheusClient('http://prom:9090/', fetchOk)('up'), ok([{ labels: { persistentvolumeclaim: 'db-x-1' }, value: 0.93 }]));
    assert.equal(seen[0], 'http://prom:9090/api/v1/query?query=up');
    const down = (async () => {
        throw new Error('connect ECONNREFUSED');
    }) as typeof fetch;
    assert.deepEqual(await prometheusClient('http://prom:9090', down)('up'), err('connect ECONNREFUSED'));
    const bad = (async () => new Response('', { status: 503 })) as typeof fetch;
    assert.deepEqual(await prometheusClient('http://prom:9090', bad)('up'), err('Prometheus answered 503'));
});

describe('growthPass', () => {
    let db: TestDatabase;
    let projectId: string;
    let accountId: string;
    before(async () => {
        db = await createTestDatabase();
        accountId = (await db.pool.query<{ id: string }>(`insert into accounts (name) values ('Acme') returning id`)).rows[0]?.id ?? '';
        projectId = (await db.pool.query<{ id: string }>(`insert into projects (account_id, name) values ($1, 'shop') returning id`, [accountId])).rows[0]?.id ?? '';
    });
    after(async () => db.close());

    const insert = async (name: string, storageGb: number, extra = '', values: unknown[] = []) =>
        (
            await db.pool.query<{ id: string }>(
                `insert into databases (project_id, name, memory_mb, storage_gb${extra ? `, ${extra}` : ''}) values ($1, $2, 256, $3${values.map((_, i) => `, $${i + 4}`).join('')}) returning id`,
                [projectId, name, storageGb, ...values],
            )
        ).rows[0]?.id ?? '';
    const sizeOf = async (dbId: string) => (await db.pool.query<{ storage_gb: number }>('select storage_gb from databases where id = $1', [dbId])).rows[0]?.storage_gb;
    const kube = (freeGb: number) =>
        ({
            storageCapacity: async () => ok(new Map([['node-fsn', freeGb * GiB], ['node-lim', freeGb * GiB]])),
            volumeNodes: async () => ok(['node-fsn', 'node-lim']),
            readCluster: async () => ok({ instances: 2, readyInstances: 2, ready: true }),
        }) as unknown as ControlPlaneKube;

    test('grows full Databases with auto-grow by half, by what fits, and leaves the others', async () => {
        const fullOne = await insert('full', 10);
        const manual = await insert('manual', 10, 'auto_grow', [false]);
        const tight = await insert('tight', 10);
        const roomy = await insert('roomy', 10);
        const usage = new Map([
            [fullOne, 0.95],
            [manual, 0.95],
            [tight, 0.95],
            [roomy, 0.5],
        ]);
        const prometheus = async (query: string) =>
            ok(
                [...usage].map(([dbId, used]) => ({
                    labels: { persistentvolumeclaim: `db-${dbId}-1` },
                    value: query === USED_QUERY ? used : query === CAPACITY_QUERY ? 9.8 * GiB : Number.NaN,
                })),
            );
        const logs: Record<string, unknown>[] = [];
        // Room for 5 GB more per node: full grows to 15; tight, grown after it, only by what is left in this fake (5 again).
        await growthPass({ pool: db.pool, kube: kube(5), prometheus, log: (entry) => logs.push(entry) });
        assert.equal(await sizeOf(fullOne), 15);
        assert.equal(await sizeOf(manual), 10, 'auto_grow off');
        assert.equal(await sizeOf(tight), 15);
        assert.equal(await sizeOf(roomy), 10, 'half used');

        await db.pool.query('update databases set storage_gb = 10 where id = $1', [tight]);
        await growthPass({ pool: db.pool, kube: kube(3), prometheus, log: (entry) => logs.push(entry) });
        assert.equal(await sizeOf(tight), 13, 'only 3 GB free: grown by that');

        await db.pool.query('update databases set storage_gb = 10 where id = $1', [tight]);
        await growthPass({ pool: db.pool, kube: kube(0.5), prometheus, log: (entry) => logs.push(entry) });
        assert.equal(await sizeOf(tight), 10);
        assert.ok(logs.some((entry) => entry['msg'] === 'growth: no room on its nodes' && entry['database'] === tight));
    });

    test("a Cluster CloudNativePG stopped for a full disk gets its PVCs grown to the row's size, once the Cluster has it", async () => {
        const stuck = await insert('stuck', 2, 'auto_grow', [false]);
        const grown: [string, number][] = [];
        let clusterGb = 1;
        const fakeKube = {
            readCluster: async () => ok({ instances: 2, readyInstances: 1, ready: false, storageGb: clusterGb, phase: 'Not enough disk space' }),
            growVolumes: async (_namespace: string, name: string, gb: number) => {
                grown.push([name, gb]);
                return ok([`${name}-1`, `${name}-2`]);
            },
            storageCapacity: async () => ok(undefined),
            volumeNodes: async () => ok([]),
        } as unknown as ControlPlaneKube;
        const prometheus = async (query: string) =>
            ok([{ labels: { persistentvolumeclaim: `db-${stuck}-1` }, value: query === USED_QUERY ? 0.9999 : 0.98 * GiB }]);
        const logs: Record<string, unknown>[] = [];
        await growthPass({ pool: db.pool, kube: fakeKube, prometheus, log: (entry) => logs.push(entry) });
        assert.deepEqual(grown, [], 'the operator has not applied the 2 GB yet');
        clusterGb = 2;
        await growthPass({ pool: db.pool, kube: fakeKube, prometheus, log: (entry) => logs.push(entry) });
        assert.deepEqual(grown, [[`db-${stuck}`, 2]], 'also with auto-grow off: the customer resized it');
        assert.ok(logs.some((entry) => entry['msg'] === 'growth: full volumes grown for CloudNativePG'));
        await db.pool.query('delete from databases where id = $1', [stuck]);
    });

    test('a held Account is not grown; Prometheus down grows nothing', async () => {
        const heldOne = await insert('held-one', 10);
        await db.pool.query(`insert into account_holds (account_id, reason) values ($1, 'unpaid')`, [accountId]);
        const prometheus = async (query: string) =>
            ok([{ labels: { persistentvolumeclaim: `db-${heldOne}-1` }, value: query === USED_QUERY ? 0.99 : 9.8 * GiB }]);
        const logs: Record<string, unknown>[] = [];
        await growthPass({ pool: db.pool, kube: kube(50), prometheus, log: (entry) => logs.push(entry) });
        assert.equal(await sizeOf(heldOne), 10);
        assert.ok(logs.some((entry) => entry['msg'] === 'growth: held, not grown'));
        await db.pool.query('delete from account_holds where account_id = $1', [accountId]);

        await growthPass({ pool: db.pool, kube: kube(50), prometheus: async () => err('connect ECONNREFUSED'), log: (entry) => logs.push(entry) });
        assert.equal(await sizeOf(heldOne), 10);
        assert.ok(logs.some((entry) => entry['msg'] === 'growth: cannot ask Prometheus'));
    });
});
