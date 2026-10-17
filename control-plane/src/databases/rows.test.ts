import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORM } from '@openupstream/sdk';
import { type TestDatabase, createTestDatabase } from '../testing/postgres.js';
import { seedPlatform } from '../platform.js';
import { listDatabaseRows } from './rows.js';

let db: TestDatabase;

before(async () => {
    db = await createTestDatabase();
});

after(async () => {
    await db.close();
});

test('no Databases, no rows', async () => {
    assert.deepEqual(await listDatabaseRows(db.pool), []);
});

test('the platform rows are seeded once and listed like any Database', async () => {
    await seedPlatform(db.pool);
    await seedPlatform(db.pool);
    assert.deepEqual(await listDatabaseRows(db.pool), [
        {
            project: { ...PLATFORM.project, createdAt: '2026-10-17T00:00:00.000Z' },
            database: { ...PLATFORM.database, createdAt: '2026-10-17T00:00:00.000Z' },
        },
    ]);
});

test('seeding never changes an existing platform row', async () => {
    await db.pool.query('update databases set memory_mb = 1024 where id = $1', [PLATFORM.database.id]);
    await seedPlatform(db.pool);
    const rows = await listDatabaseRows(db.pool);
    assert.equal(rows.find((row) => row.database.id === PLATFORM.database.id)?.database.memoryMb, 1024);
});

test("each Database comes with its own Project, in creation order", async () => {
    const { rows: accounts } = await db.pool.query<{ id: string }>(
        `insert into accounts (name) values ('Acme') returning id`,
    );
    const accountId = accounts[0]?.id;
    const { rows: projects } = await db.pool.query<{ id: string }>(
        `insert into projects (account_id, name) values ($1, 'shop-prod'), ($1, 'shop-staging') returning id`,
        [accountId],
    );
    const [prod, staging] = projects.map((row) => row.id);
    await db.pool.query(
        `insert into databases (project_id, name, home_site, memory_mb, storage_gb, created_at) values
         ($1, 'orders', 'ovh-lim', 512, 10, '2026-10-18T00:00:00Z'),
         ($2, 'orders', 'hetzner-fsn1', 256, 1, '2026-10-19T00:00:00Z')`,
        [prod, staging],
    );
    const rows = (await listDatabaseRows(db.pool)).filter((row) => row.project.accountId === accountId);
    assert.deepEqual(
        rows.map(({ project, database }) => ({
            project: project.name,
            projectId: database.projectId === project.id,
            home: database.homeSite,
            memory: database.memoryMb,
            storage: database.storageGb,
            created: database.createdAt,
        })),
        [
            { project: 'shop-prod', projectId: true, home: 'ovh-lim', memory: 512, storage: 10, created: '2026-10-18T00:00:00.000Z' },
            { project: 'shop-staging', projectId: true, home: 'hetzner-fsn1', memory: 256, storage: 1, created: '2026-10-19T00:00:00.000Z' },
        ],
    );
    assert.equal(rows[0]?.project.id, prod);
    assert.equal(rows[1]?.project.id, staging);
});
