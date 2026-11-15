import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { err, ok } from '../result.js';
import { fakeStorage } from '../testing/storage.js';
import { type TestDatabase, createTestDatabase } from '../testing/postgres.js';
import { CPU_QUERY, EGRESS_QUERY, HOUR_MS, MEMORY_QUERY, eventsForHour, hoursToMeter, meteringPass, shareOfHour } from './meter.js';
import { accountUsage, monthBounds } from './store.js';

const GiB = 1024 ** 3;
const project = '11111111-1111-4111-8111-111111111111';
const account = '22222222-2222-4222-8222-222222222222';
const db = '33333333-3333-4333-8333-333333333333';
const svc = '44444444-4444-4444-8444-444444444444';
const job = '55555555-5555-4555-8555-555555555555';
const bucket = '66666666-6666-4666-8666-666666666666';
const hour = new Date('2026-11-15T10:00:00Z');
const ns = `project-${project}`;
const empty = { cpu: [], memory: [], egress: [], databases: [], buckets: [], accountOf: new Map([[project, account]]) };

test('the share of an hour a Resource existed', () => {
    const at = (minute: number) => new Date(hour.getTime() + minute * 60_000);
    assert.equal(shareOfHour(hour, new Date(0), undefined), 1);
    assert.equal(shareOfHour(hour, at(15), undefined), 0.75);
    assert.equal(shareOfHour(hour, at(15), at(45)), 0.5);
    assert.equal(shareOfHour(hour, at(70), undefined), 0, 'created after the hour');
    assert.equal(shareOfHour(hour, new Date(0), at(-5)), 0, 'deleted before it');
});

describe('eventsForHour', () => {
    test("pods' CPU is summed per Resource: both Database instances and the Pooler, every replica, every run", () => {
        const pod = (name: string, value: number) => ({ labels: { namespace: ns, pod: name }, value });
        const { events, unattributed } = eventsForHour(hour, {
            ...empty,
            cpu: [pod(`db-${db}-1`, 30), pod(`db-${db}-2`, 10), pod(`db-${db}-pooler-7d9f-abcde`, 2), pod(`svc-${svc}-5c8b-x1`, 100), pod(`svc-${svc}-5c8b-x2`, 50), pod(`job-${job}-29123456-q2`, 7), pod('madauth-1', 9)],
        });
        assert.deepEqual(
            events.map((e) => [e.kind, e.resourceId, e.unit, e.quantity]),
            [
                ['database', db, 'cpu_seconds', 42],
                ['service', svc, 'cpu_seconds', 150],
                ['job', job, 'cpu_seconds', 7],
            ],
        );
        assert.equal(unattributed, 1, 'a pod of no Resource');
        assert.ok(events.every((e) => e.accountId === account && e.projectId === project));
    });

    test("a Service's and Job's memory from their running pods' byte-minutes; a Database's from its row, once, for its share of the hour", () => {
        const { events } = eventsForHour(hour, {
            ...empty,
            // Two replicas of 512 MiB running all hour: 2 × 512 MiB × 60 min.
            memory: [{ labels: { namespace: ns, pod: `svc-${svc}-a` }, value: 512 * 1024 ** 2 * 60 }, { labels: { namespace: ns, pod: `svc-${svc}-b` }, value: 512 * 1024 ** 2 * 60 }],
            databases: [{ id: db, projectId: project, memoryMb: 1024, storageGb: 10, createdAt: new Date(hour.getTime() + 30 * 60_000), deletedAt: undefined }],
        });
        assert.deepEqual(
            events.map((e) => [e.kind, e.unit, e.quantity]),
            [
                ['service', 'memory_gb_hours', 1],
                ['database', 'memory_gb_hours', 0.5],
                ['database', 'storage_gb_hours', 5],
            ],
        );
    });

    test("egress per backend Service, a Bucket's storage from its bytes", () => {
        const { events, unattributed } = eventsForHour(hour, {
            ...empty,
            egress: [
                { labels: { service: `${ns}-svc-${svc}-8080@kubernetescrd` }, value: 2 * GiB },
                { labels: { service: `${ns}-bucket-${bucket}-3902@kubernetescrd` }, value: GiB / 2 },
                { labels: { service: 'project-platform-madauth-8787@kubernetescrd' }, value: GiB },
            ],
            buckets: [{ id: bucket, projectId: project, bytes: 3 * GiB, createdAt: new Date(0), deletedAt: undefined }],
        });
        assert.deepEqual(
            events.map((e) => [e.kind, e.resourceId, e.unit, e.quantity]),
            [
                ['service', svc, 'egress_gb', 2],
                ['bucket', bucket, 'egress_gb', 0.5],
                ['bucket', bucket, 'storage_gb_hours', 3],
            ],
        );
        assert.equal(unattributed, 1);
    });

    test('nothing for zero, and nothing for a Project whose Account is unknown', () => {
        const { events, unattributed } = eventsForHour(hour, {
            ...empty,
            cpu: [{ labels: { namespace: ns, pod: `svc-${svc}-a` }, value: 0 }],
            accountOf: new Map(),
            databases: [{ id: db, projectId: project, memoryMb: 256, storageGb: 1, createdAt: new Date(0), deletedAt: undefined }],
        });
        assert.deepEqual(events, []);
        assert.equal(unattributed, 2, "the Database's memory and storage");
    });
});

test('the hours to meter: after the last one, complete and settled, at most a day per pass, never older than Prometheus keeps', () => {
    const now = new Date('2026-11-15T10:04:00Z');
    assert.deepEqual(hoursToMeter(undefined, now).map((h) => h.toISOString()), ['2026-11-15T08:00:00.000Z'], 'first run: the last settled hour; 09:00 ends at 10:00 and settles at 10:05');
    assert.deepEqual(hoursToMeter(new Date('2026-11-15T08:00:00Z'), now), []);
    assert.deepEqual(hoursToMeter(new Date('2026-11-15T08:00:00Z'), new Date('2026-11-15T10:06:00Z')).map((h) => h.toISOString()), ['2026-11-15T09:00:00.000Z']);
    assert.equal(hoursToMeter(new Date('2026-11-13T00:00:00Z'), now).length, 24);
    assert.equal(hoursToMeter(new Date('2026-10-01T00:00:00Z'), now)[0]?.toISOString(), '2026-11-01T11:00:00.000Z', 'from 14 days back');
});

test('months in UTC', () => {
    assert.deepEqual(monthBounds('2026-11'), { start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-12-01T00:00:00Z') });
    assert.deepEqual(monthBounds('2026-12')?.end, new Date('2027-01-01T00:00:00Z'));
    assert.equal(monthBounds('2026-13'), undefined);
    assert.equal(monthBounds('26-11'), undefined);
});

describe('meteringPass', () => {
    let tdb: TestDatabase;
    let projectId: string;
    let accountId: string;
    let databaseId: string;
    const storage = fakeStorage();
    before(async () => {
        tdb = await createTestDatabase();
        accountId = (await tdb.pool.query<{ id: string }>(`insert into accounts (name) values ('Acme') returning id`)).rows[0]?.id ?? '';
        projectId = (await tdb.pool.query<{ id: string }>(`insert into projects (account_id, name) values ($1, 'shop') returning id`, [accountId])).rows[0]?.id ?? '';
        databaseId = (
            await tdb.pool.query<{ id: string }>(`insert into databases (project_id, name, memory_mb, storage_gb, created_at) values ($1, 'main', 512, 4, '2026-11-01') returning id`, [projectId])
        ).rows[0]?.id ?? '';
        const created = await storage.createBucket('shop-assets');
        assert.ok(created.ok);
        const garage = storage.buckets.get('shop-assets');
        if (garage !== undefined) garage.bytes = 2 * GiB;
        await tdb.pool.query(`insert into buckets (project_id, name, garage_bucket_id, access_key_id, created_at) values ($1, 'shop-assets', $2, $3, '2026-11-01')`, [
            projectId,
            created.value.bucketId,
            created.value.accessKeyId,
        ]);
    });
    after(async () => tdb.close());

    const prometheus = (down = false) => async (query: string, time?: Date) => {
        if (down) return err('connect ECONNREFUSED');
        assert.equal(time?.getUTCMinutes(), 0, 'each hour queried at its end');
        return ok(query === CPU_QUERY ? [{ labels: { namespace: `project-${projectId}`, pod: `db-${databaseId}-1` }, value: 36 }] : query === MEMORY_QUERY || query === EGRESS_QUERY ? [] : []);
    };

    test('meters each settled hour once, with every unit, and the billing service reads the month', async () => {
        const logs: Record<string, unknown>[] = [];
        await tdb.pool.query(`insert into metered_hours (hour) values ('2026-11-15T07:00:00Z')`);
        const now = () => new Date('2026-11-15T10:06:00Z');
        await meteringPass({ pool: tdb.pool, prometheus: prometheus(), storage, log: (e) => logs.push(e), now });
        await meteringPass({ pool: tdb.pool, prometheus: prometheus(), storage, log: (e) => logs.push(e), now });
        const hours = await tdb.pool.query<{ hour: Date }>('select hour from metered_hours order by hour');
        assert.deepEqual(hours.rows.map((r) => r.hour.toISOString()), ['2026-11-15T07:00:00.000Z', '2026-11-15T08:00:00.000Z', '2026-11-15T09:00:00.000Z']);
        const events = await tdb.pool.query<{ resource_kind: string; unit: string; quantity: string; interval_start: Date }>(
            `select resource_kind, unit, quantity, interval_start from usage_events where interval_start = '2026-11-15T08:00:00Z' order by resource_kind, unit`,
        );
        assert.deepEqual(
            events.rows.map((r) => [r.resource_kind, r.unit, Number(r.quantity)]),
            [
                ['bucket', 'storage_gb_hours', 2],
                ['database', 'cpu_seconds', 36],
                ['database', 'memory_gb_hours', 0.5],
                ['database', 'storage_gb_hours', 4],
            ],
        );
        const usage = await accountUsage(tdb.pool, accountId, '2026-11');
        assert.deepEqual([usage?.hours, usage?.meteredHours], [720, 3]);
        assert.deepEqual(
            usage?.usage.find((u) => u.resource.kind === 'database' && u.unit === 'storage_gb_hours'),
            { projectId, resource: { kind: 'database', id: databaseId }, unit: 'storage_gb_hours', quantity: 8 },
            'two hours of 4 GB',
        );
        assert.equal(logs.filter((e) => e['msg'] === 'metering: hour metered').length, 2, 'the second pass found nothing new');
    });

    test('Prometheus or Garage down: the hour waits, nothing is written', async () => {
        const logs: Record<string, unknown>[] = [];
        const now = () => new Date('2026-11-15T11:06:00Z');
        await meteringPass({ pool: tdb.pool, prometheus: prometheus(true), storage, log: (e) => logs.push(e), now });
        storage.down = true;
        await meteringPass({ pool: tdb.pool, prometheus: prometheus(), storage, log: (e) => logs.push(e), now });
        storage.down = false;
        const metered = await tdb.pool.query(`select 1 from metered_hours where hour = '2026-11-15T10:00:00Z'`);
        assert.equal(metered.rowCount, 0);
        assert.deepEqual(logs.map((e) => e['msg']), ['metering: hour not metered yet', 'metering: hour not metered yet']);
        await meteringPass({ pool: tdb.pool, prometheus: prometheus(), storage, log: (e) => logs.push(e), now });
        assert.equal((await tdb.pool.query(`select 1 from metered_hours where hour = '2026-11-15T10:00:00Z'`)).rowCount, 1);
    });

    test('a deleted Database is billed for the part of the hour it lived', async () => {
        await tdb.pool.query(`update databases set deleted_at = '2026-11-15T11:15:00Z' where id = $1`, [databaseId]);
        await meteringPass({ pool: tdb.pool, prometheus: prometheus(), storage, log: () => undefined, now: () => new Date('2026-11-15T13:06:00Z') });
        const events = await tdb.pool.query<{ unit: string; quantity: string; interval_start: Date }>(
            `select unit, quantity, interval_start from usage_events where resource_id = $1 and unit = 'storage_gb_hours' and interval_start >= '2026-11-15T11:00:00Z' order by interval_start`,
            [databaseId],
        );
        assert.deepEqual(events.rows.map((r) => [r.interval_start.toISOString(), Number(r.quantity)]), [['2026-11-15T11:00:00.000Z', 1]]);
        assert.equal(HOUR_MS, 3_600_000);
    });
});
