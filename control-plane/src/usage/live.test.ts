import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Bucket, Database, Job, Service } from '@openupstream/sdk';
import type { PodInfo } from '../kube.js';
import { err, ok } from '../result.js';
import { cpuQuery, diskQuery, measure, memoryQuery, usageOf } from './live.js';

const PROJECT = '10000000-0000-4000-8000-000000000001';
const DB = '20000000-0000-4000-8000-000000000001';
const SVC = '30000000-0000-4000-8000-000000000001';
const JOB = '40000000-0000-4000-8000-000000000001';
const BUCKET = '50000000-0000-4000-8000-000000000001';
const NAMESPACE = `project-${PROJECT}`;

const database = { id: DB, projectId: PROJECT, name: 'main', memoryMb: 512, storageGb: 10 } as Database;
const service = { id: SVC, projectId: PROJECT, name: 'web', replicas: 2, memoryMb: 256, cpuMillicores: 250 } as Service;
const job = { id: JOB, projectId: PROJECT, name: 'report', memoryMb: 128, cpuMillicores: 100 } as Job;
const bucket = { id: BUCKET, projectId: PROJECT, name: 'assets' } as Bucket;
const rows = { databases: [database], services: [service], jobs: [job], buckets: [bucket] };

const pod = (name: string, phase: string, more: Partial<PodInfo> = {}): PodInfo => ({
    name,
    nodeName: 'node-a',
    containers: [{ name: 'main', restartCount: 0, state: phase === 'Running' ? 'running' : phase === 'Pending' ? 'waiting' : 'terminated' }],
    phase,
    startedAt: new Date('2026-11-15T10:00:00Z'),
    terminating: false,
    ...more,
});

const pods = [
    pod(`db-${DB}-2`, 'Running', { nodeName: 'node-b' }),
    pod(`db-${DB}-1`, 'Running'),
    pod(`db-${DB}-pooler-7fc97584bb-8ppj5`, 'Running'),
    pod(`svc-${SVC}-5d4f-abcde`, 'Running', { containers: [{ name: 'main', restartCount: 3, state: 'waiting' }] }),
    // Not scheduled yet: no node, no start time.
    { name: `svc-${SVC}-5d4f-fghij`, nodeName: undefined, containers: [{ name: 'main', restartCount: 0, state: 'waiting' as const }], phase: 'Pending', terminating: false },
    pod(`job-${JOB}-0a1b2c3d-xk2p9`, 'Succeeded'),
    pod(`job-${JOB}-9f8e7d6c-q1w2e`, 'Running', { terminating: true }),
    pod('svc-60000000-0000-4000-8000-000000000001-x-y', 'Running'),
    pod('something-else', 'Running'),
];
const sites = new Map<string, 'hetzner-fsn1' | 'ovh-lim' | null>([
    [`db-${DB}-1`, 'hetzner-fsn1'],
    [`db-${DB}-2`, 'ovh-lim'],
]);
const measurements = {
    cpuCores: new Map([
        [`db-${DB}-1`, 0.0344],
        [`db-${DB}-2`, 0.01],
        [`db-${DB}-pooler-7fc97584bb-8ppj5`, 0.0005],
        [`svc-${SVC}-5d4f-abcde`, 0.2],
        [`job-${JOB}-0a1b2c3d-xk2p9`, 0.5],
    ]),
    memoryBytes: new Map([
        [`db-${DB}-1`, 140_000_000],
        [`db-${DB}-2`, 130_000_000],
        [`db-${DB}-pooler-7fc97584bb-8ppj5`, 20_000_000],
        [`svc-${SVC}-5d4f-abcde`, 50_000_000],
    ]),
    diskBytes: new Map([
        [`db-${DB}-1`, 300_000_000],
        [`db-${DB}-2`, 310_000_000],
    ]),
};

test('each Resource with its instances, summed; a Database\'s disk is its fullest instance', () => {
    const [db, svc, run, assets] = usageOf(rows, pods, sites, measurements, new Map([[BUCKET, 4096]]));
    assert.deepEqual(
        db?.instances.map((instance) => [instance.name, instance.role, instance.site, instance.state, instance.cpuMillicores, instance.storageBytes]),
        [
            ['1', 'database', 'hetzner-fsn1', 'running', 34, 300_000_000],
            ['2', 'database', 'ovh-lim', 'running', 10, 310_000_000],
            ['pooler-7fc97584bb-8ppj5', 'pooler', null, 'running', 1, null],
        ],
    );
    assert.deepEqual(db?.cpuMillicores, { used: 45, allocated: null });
    assert.deepEqual(db?.memoryBytes, { used: 290_000_000, allocated: 2 * 512 * 2 ** 20 });
    assert.deepEqual(db?.storageBytes, { used: 310_000_000, allocated: 10 * 2 ** 30 });

    assert.deepEqual(
        svc?.instances.map((instance) => [instance.name, instance.state, instance.restarts, instance.startedAt, instance.memoryBytes]),
        [
            ['5d4f-abcde', 'restarting', 3, '2026-11-15T10:00:00.000Z', 50_000_000],
            ['5d4f-fghij', 'starting', 0, null, null],
        ],
    );
    assert.deepEqual(svc?.cpuMillicores, { used: 200, allocated: 500 });
    assert.deepEqual(svc?.memoryBytes, { used: 50_000_000, allocated: 2 * 256 * 2 ** 20 });
    assert.deepEqual(svc?.storageBytes, { used: null, allocated: null });

    // A run that ended is listed, and neither its use nor its size counts any more.
    assert.deepEqual(run?.instances.map((instance) => [instance.name, instance.role, instance.state]), [
        ['0a1b2c3d-xk2p9', 'run', 'succeeded'],
        ['9f8e7d6c-q1w2e', 'run', 'stopping'],
    ]);
    assert.deepEqual(run?.cpuMillicores, { used: null, allocated: 100 });
    assert.deepEqual(run?.memoryBytes, { used: null, allocated: 128 * 2 ** 20 });

    assert.deepEqual(assets, {
        kind: 'bucket',
        id: BUCKET,
        name: 'assets',
        cpuMillicores: { used: null, allocated: null },
        memoryBytes: { used: null, allocated: null },
        storageBytes: { used: 4096, allocated: null },
        instances: [],
    });
});

test('without measurements the instances are listed and nothing is used; a Database without pods still has its sizes', () => {
    const [db, svc, , assets] = usageOf(rows, pods.slice(0, 2), sites, undefined, new Map());
    assert.deepEqual(db?.instances.map((instance) => [instance.name, instance.cpuMillicores, instance.memoryBytes, instance.storageBytes]), [
        ['1', null, null, null],
        ['2', null, null, null],
    ]);
    assert.deepEqual(db?.storageBytes, { used: null, allocated: 10 * 2 ** 30 });
    assert.deepEqual(svc?.instances, []);
    assert.deepEqual(svc?.memoryBytes, { used: null, allocated: 2 * 256 * 2 ** 20 });
    assert.equal(assets?.storageBytes.used, null);
    const [alone] = usageOf({ ...rows, services: [], jobs: [], buckets: [] }, [], new Map(), undefined, new Map());
    assert.deepEqual(alone?.memoryBytes, { used: null, allocated: 512 * 2 ** 20 });
});

test('the three queries are asked for the Project\'s namespace; a volume\'s figure is found by its claim, Postgres\'s by its pod', async () => {
    const asked: string[] = [];
    const prometheus = (label: string) => async (query: string) => {
        asked.push(query);
        return ok([
            { labels: { [query.includes('volume_stats') || query.includes('cnpg') ? label : 'pod']: `db-${DB}-1` }, value: 7 },
            { labels: {}, value: 1 },
        ]);
    };
    const dedicated = await measure(prometheus('persistentvolumeclaim'), PROJECT, 'dedicated');
    assert.ok(dedicated.ok);
    assert.deepEqual(asked, [cpuQuery(NAMESPACE), memoryQuery(NAMESPACE), diskQuery(NAMESPACE, 'dedicated')]);
    assert.deepEqual([...dedicated.value.diskBytes], [[`db-${DB}-1`, 7]]);
    assert.deepEqual([...dedicated.value.cpuCores], [[`db-${DB}-1`, 7]]);
    assert.match(diskQuery(NAMESPACE, 'dedicated'), /^max by \(persistentvolumeclaim\) \(kubelet_volume_stats_used_bytes\{namespace="project-1/);
    const shared = await measure(prometheus('pod'), PROJECT, 'shared');
    assert.ok(shared.ok);
    assert.deepEqual([...shared.value.diskBytes], [[`db-${DB}-1`, 7]]);
    assert.match(diskQuery(NAMESPACE, 'shared'), /cnpg_pg_database_size_bytes.*cnpg_collector_pg_wal\{namespace="project-1[^}]*value="size"\}/);
});

test('Prometheus not answering one query is an error', async () => {
    const down = await measure(async (query) => (query === memoryQuery(NAMESPACE) ? err('connect ECONNREFUSED') : ok([])), PROJECT, 'dedicated');
    assert.deepEqual(down, err('connect ECONNREFUSED'));
});
