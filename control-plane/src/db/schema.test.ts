import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { COMPUTE_SITES, DATABASE_MIN_MEMORY_MB, RESOURCE_KINDS, USAGE_UNITS } from '@openupstream/sdk';
import { type TestDatabase, createTestDatabase } from '../testing/postgres.js';
import { readdir } from 'node:fs/promises';
import { MIGRATIONS_DIR, migrate } from './migrate.js';
import { putSecret } from '../secrets/store.js';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
const RESTRICT_VIOLATION = '23001';

let db: TestDatabase;

before(async () => {
    db = await createTestDatabase();
});

after(async () => {
    await db.close();
});

async function rejectsWith(query: Promise<unknown>, code: string): Promise<void> {
    await assert.rejects(query, (error: unknown) => error instanceof pg.DatabaseError && error.code === code);
}

async function insert(sql: string, params: readonly unknown[]): Promise<string> {
    const result = await db.pool.query<{ id: string }>(`${sql} returning id`, [...params]);
    const row = result.rows[0];
    assert.ok(row);
    return row.id;
}

const unique = (prefix: string): string => `${prefix}-${randomBytes(4).toString('hex')}`;
const token = (): string => randomBytes(24).toString('hex');

const createAccount = (): Promise<string> => insert('insert into accounts (name) values ($1)', ['Acme']);

const createProject = (accountId: string): Promise<string> =>
    insert('insert into projects (account_id, name) values ($1, $2)', [accountId, unique('p')]);

const createBucket = (projectId: string): Promise<string> =>
    insert("insert into buckets (project_id, name, garage_bucket_id, access_key_id) values ($1, $2, 'b', 'GK')", [projectId, unique('b')]);

const createService = (projectId: string): Promise<string> =>
    insert(
        `insert into services (project_id, name, image, image_digest, memory_mb, cpu_millicores, port)
         values ($1, $2, 'ghcr.io/acme/api:1', 'sha256:${'0'.repeat(64)}', 512, 250, 8080)`,
        [projectId, unique('s')],
    );

const createDefaultDomain = (projectId: string, hostname = `${unique('p')}.example.app`): Promise<string> =>
    insert(`insert into domains (project_id, hostname, kind, verified_at) values ($1, $2, 'default', now())`, [
        projectId,
        hostname,
    ]);

const claimCustomDomain = (projectId: string, hostname: string): Promise<string> =>
    insert(`insert into domains (project_id, hostname, kind, verification_token) values ($1, $2, 'custom', $3)`, [
        projectId,
        hostname,
        token(),
    ]);

const verifyDomain = (domainId: string): Promise<unknown> =>
    db.pool.query('update domains set verified_at = now() where id = $1', [domainId]);

async function newProject(): Promise<{ accountId: string; projectId: string }> {
    const accountId = await createAccount();
    return { accountId, projectId: await createProject(accountId) };
}

async function count(table: string, projectId: string): Promise<number> {
    const result = await db.pool.query<{ n: number }>(`select count(*)::int as n from ${table} where project_id = $1`, [
        projectId,
    ]);
    return result.rows[0]?.n ?? -1;
}

describe('Domains', () => {
    test('a hostname is routed for at most one Domain', async () => {
        const { projectId: a } = await newProject();
        const { projectId: b } = await newProject();
        const hostname = `${unique('shop')}.example.com`;

        await createDefaultDomain(a, `${unique('a')}.example.app`);
        const claimA = await claimCustomDomain(a, hostname);
        const claimB = await claimCustomDomain(b, hostname);

        await verifyDomain(claimA);
        await rejectsWith(verifyDomain(claimB), UNIQUE_VIOLATION);
    });

    test('default hostnames are unique across Projects', async () => {
        const { projectId: a } = await newProject();
        const { projectId: b } = await newProject();
        const hostname = `${unique('p')}.example.app`;
        await createDefaultDomain(a, hostname);
        await rejectsWith(createDefaultDomain(b, hostname), UNIQUE_VIOLATION);
    });

    test('a pending claim does not reserve the hostname', async () => {
        const { projectId: squatter } = await newProject();
        const { projectId: owner } = await newProject();
        const hostname = `${unique('shop')}.example.com`;
        await claimCustomDomain(squatter, hostname);
        await verifyDomain(await claimCustomDomain(owner, hostname));
    });

    test('a Project claims a hostname once and has one default Domain', async () => {
        const { projectId } = await newProject();
        const hostname = `${unique('shop')}.example.com`;
        await claimCustomDomain(projectId, hostname);
        await rejectsWith(claimCustomDomain(projectId, hostname), UNIQUE_VIOLATION);

        await createDefaultDomain(projectId);
        await rejectsWith(createDefaultDomain(projectId), UNIQUE_VIOLATION);
    });

    test('a default Domain is verified, a custom one needs a token', async () => {
        const { projectId } = await newProject();
        await rejectsWith(
            db.pool.query(`insert into domains (project_id, hostname, kind) values ($1, 'a.example.app', 'default')`, [
                projectId,
            ]),
            CHECK_VIOLATION,
        );
        await rejectsWith(
            db.pool.query(`insert into domains (project_id, hostname, kind) values ($1, 'a.example.com', 'custom')`, [
                projectId,
            ]),
            CHECK_VIOLATION,
        );
    });

    test('hostnames are lowercase DNS names', async () => {
        const { projectId } = await newProject();
        for (const hostname of ['Shop.example.com', 'localhost', 'a..example.com', '-a.example.com']) {
            await rejectsWith(claimCustomDomain(projectId, hostname), CHECK_VIOLATION);
        }
    });
});

describe('Routes', () => {
    const route = (projectId: string, domainId: string, target: { bucketId?: string; serviceId?: string }, prefix = '/') =>
        db.pool.query(
            `insert into routes (project_id, domain_id, path_prefix, bucket_id, service_id, spa_fallback)
             values ($1, $2, $3, $4, $5, $6)`,
            [projectId, domainId, prefix, target.bucketId ?? null, target.serviceId ?? null, false],
        );

    test('a Route targets a Bucket or Service of its Domain\'s Project', async () => {
        const { projectId } = await newProject();
        const domainId = await createDefaultDomain(projectId);
        await route(projectId, domainId, { bucketId: await createBucket(projectId) }, '/');
        await route(projectId, domainId, { serviceId: await createService(projectId) }, '/api');
    });

    test('a Route cannot target another Project\'s Bucket or Service', async () => {
        const { projectId: mine } = await newProject();
        const { projectId: theirs } = await newProject();
        const domainId = await createDefaultDomain(mine);
        const theirBucket = await createBucket(theirs);
        const theirService = await createService(theirs);

        await rejectsWith(route(mine, domainId, { bucketId: theirBucket }), FOREIGN_KEY_VIOLATION);
        await rejectsWith(route(mine, domainId, { serviceId: theirService }), FOREIGN_KEY_VIOLATION);
        // Claiming to be the other Project does not help: the Domain is not theirs.
        await rejectsWith(route(theirs, domainId, { bucketId: theirBucket }), FOREIGN_KEY_VIOLATION);
    });

    test('a Route has exactly one target, and SPA fallback only for a Bucket', async () => {
        const { projectId } = await newProject();
        const domainId = await createDefaultDomain(projectId);
        const bucketId = await createBucket(projectId);
        const serviceId = await createService(projectId);

        await rejectsWith(route(projectId, domainId, {}), CHECK_VIOLATION);
        await rejectsWith(route(projectId, domainId, { bucketId, serviceId }), CHECK_VIOLATION);
        await rejectsWith(
            db.pool.query(
                `insert into routes (project_id, domain_id, path_prefix, service_id, spa_fallback)
                 values ($1, $2, '/', $3, true)`,
                [projectId, domainId, serviceId],
            ),
            CHECK_VIOLATION,
        );
        await db.pool.query(
            `insert into routes (project_id, domain_id, path_prefix, bucket_id, spa_fallback)
             values ($1, $2, '/', $3, true)`,
            [projectId, domainId, bucketId],
        );
    });

    test('a path prefix appears once per Domain and is normalized', async () => {
        const { projectId } = await newProject();
        const domainId = await createDefaultDomain(projectId);
        const bucketId = await createBucket(projectId);
        await route(projectId, domainId, { bucketId }, '/docs');
        await rejectsWith(route(projectId, domainId, { bucketId }, '/docs'), UNIQUE_VIOLATION);
        for (const prefix of ['', 'docs', '/docs/', '//docs', '/a b']) {
            await rejectsWith(route(projectId, domainId, { bucketId }, prefix), CHECK_VIOLATION);
        }
    });

    test('a routed Bucket or Service cannot be deleted; deleting the Domain removes its Routes', async () => {
        const { projectId } = await newProject();
        const domainId = await createDefaultDomain(projectId);
        const bucketId = await createBucket(projectId);
        const serviceId = await createService(projectId);
        await route(projectId, domainId, { bucketId }, '/');
        await route(projectId, domainId, { serviceId }, '/api');

        await rejectsWith(db.pool.query('delete from buckets where id = $1', [bucketId]), FOREIGN_KEY_VIOLATION);
        await rejectsWith(db.pool.query('delete from services where id = $1', [serviceId]), FOREIGN_KEY_VIOLATION);

        await db.pool.query('delete from domains where id = $1', [domainId]);
        assert.equal(await count('routes', projectId), 0);
        await db.pool.query('delete from buckets where id = $1', [bucketId]);
    });
});

describe('Resources', () => {
    test('Bucket names are unique across all Projects', async () => {
        const { projectId: a } = await newProject();
        const { projectId: b } = await newProject();
        const name = unique('assets');
        await db.pool.query("insert into buckets (project_id, name, garage_bucket_id, access_key_id) values ($1, $2, 'b', 'GK')", [a, name]);
        await rejectsWith(db.pool.query("insert into buckets (project_id, name, garage_bucket_id, access_key_id) values ($1, $2, 'b', 'GK')", [b, name]), UNIQUE_VIOLATION);
    });

    test('a Database has at least the memory floor and runs in a compute Site', async () => {
        const { projectId } = await newProject();
        const create = (homeSite: string, memoryMb: number) =>
            db.pool.query(
                'insert into databases (project_id, name, home_site, memory_mb, storage_gb) values ($1, $2, $3, $4, 10)',
                [projectId, unique('db'), homeSite, memoryMb],
            );
        for (const site of COMPUTE_SITES) {
            await create(site, DATABASE_MIN_MEMORY_MB);
        }
        await rejectsWith(create('hetzner-fsn1', DATABASE_MIN_MEMORY_MB - 1), CHECK_VIOLATION);
        await rejectsWith(create('netcup-nbg', DATABASE_MIN_MEMORY_MB), CHECK_VIOLATION);
    });
});

describe('Projects', () => {
    test('deleting a Project deletes everything in it, but keeps its usage events', async () => {
        const { accountId, projectId } = await newProject();
        const { projectId: otherProjectId } = await newProject();
        const domainId = await createDefaultDomain(projectId);
        const bucketId = await createBucket(projectId);
        const serviceId = await createService(projectId);
        await db.pool.query(
            `insert into databases (project_id, name, memory_mb, storage_gb) values ($1, 'main', 256, 10)`,
            [projectId],
        );
        await db.pool.query(
            `insert into routes (project_id, domain_id, path_prefix, bucket_id, spa_fallback) values ($1, $2, '/', $3, true)`,
            [projectId, domainId, bucketId],
        );
        await db.pool.query(
            `insert into routes (project_id, domain_id, path_prefix, service_id) values ($1, $2, '/api', $3)`,
            [projectId, domainId, serviceId],
        );
        await claimCustomDomain(projectId, `${unique('shop')}.example.com`);
        const kek = { id: 'kek-1', key: randomBytes(32) };
        assert.ok((await putSecret(db.pool, kek, projectId, { name: 'API_KEY', value: 'x' })).ok);
        assert.ok((await putSecret(db.pool, kek, otherProjectId, { name: 'API_KEY', value: 'y' })).ok);
        await db.pool.query(
            `insert into usage_events (account_id, project_id, resource_kind, resource_id, unit, quantity, interval_start, interval_end)
             values ($1, $2, 'bucket', $3, 'storage_gb_hours', 1.5, now() - interval '1 hour', now())`,
            [accountId, projectId, bucketId],
        );

        await db.pool.query('delete from projects where id = $1', [projectId]);

        const tables = ['databases', 'buckets', 'services', 'domains', 'routes', 'secrets', 'project_data_keys'];
        for (const table of tables) {
            assert.equal(await count(table, projectId), 0, `${table} still has rows of the deleted Project`);
        }
        assert.equal(await count('secrets', otherProjectId), 1);
        assert.equal(await count('usage_events', projectId), 1);
    });

    test('an Account with Projects cannot be deleted; deleting an empty one removes its Members', async () => {
        const { accountId, projectId } = await newProject();
        await db.pool.query(`insert into members (account_id, auth_subject, email) values ($1, 'sub-1', 'a@example.com')`, [
            accountId,
        ]);
        await rejectsWith(db.pool.query('delete from accounts where id = $1', [accountId]), FOREIGN_KEY_VIOLATION);

        await db.pool.query('delete from projects where id = $1', [projectId]);
        await db.pool.query('delete from accounts where id = $1', [accountId]);
        const members = await db.pool.query('select 1 from members where account_id = $1', [accountId]);
        assert.equal(members.rowCount, 0);
    });

    test('Project names are unique within an Account', async () => {
        const accountId = await createAccount();
        await db.pool.query(`insert into projects (account_id, name) values ($1, 'staging')`, [accountId]);
        await rejectsWith(
            db.pool.query(`insert into projects (account_id, name) values ($1, 'staging')`, [accountId]),
            UNIQUE_VIOLATION,
        );
        await db.pool.query(`insert into projects (account_id, name) values ($1, 'staging')`, [await createAccount()]);
    });
});

describe('Usage events', () => {
    const insertEvent = (unit: string, quantity: number, resourceKind = 'service', length = "interval '1 hour'") =>
        db.pool.query(
            `insert into usage_events (account_id, project_id, resource_kind, resource_id, unit, quantity, interval_start, interval_end)
             values (gen_random_uuid(), gen_random_uuid(), $1, gen_random_uuid(), $2, $3, now(), now() + ${length})`,
            [resourceKind, unit, quantity],
        );

    test('every unit and Resource kind of the API can be recorded', async () => {
        for (const unit of USAGE_UNITS) {
            for (const kind of RESOURCE_KINDS) {
                await insertEvent(unit, 0.25, kind);
            }
        }
        await rejectsWith(insertEvent('requests', 1), CHECK_VIOLATION);
        await rejectsWith(insertEvent('cpu_seconds', 1, 'cron_job'), CHECK_VIOLATION);
    });

    test('quantities are not negative and intervals not empty', async () => {
        await rejectsWith(insertEvent('cpu_seconds', -1), CHECK_VIOLATION);
        await rejectsWith(insertEvent('cpu_seconds', 1, 'service', "interval '0'"), CHECK_VIOLATION);
    });

    test('an event is recorded once per Resource, unit and interval start', async () => {
        const insert = () =>
            db.pool.query(
                `insert into usage_events (account_id, project_id, resource_kind, resource_id, unit, quantity, interval_start, interval_end)
                 values ($1, $1, 'service', $1, 'cpu_seconds', 3, '2026-10-17T10:00:00Z', '2026-10-17T11:00:00Z')`,
                ['6a1d1f9e-0c55-4b8e-9d0c-3c7a2e1f5b00'],
            );
        await insert();
        await rejectsWith(insert(), UNIQUE_VIOLATION);
    });

    test('usage events are append-only', async () => {
        await insertEvent('egress_gb', 2);
        await rejectsWith(db.pool.query('update usage_events set quantity = 0'), RESTRICT_VIOLATION);
        await rejectsWith(db.pool.query('delete from usage_events'), RESTRICT_VIOLATION);
        await rejectsWith(db.pool.query('truncate usage_events'), RESTRICT_VIOLATION);
    });
});

describe('Migrations', () => {
    test('revert and re-apply cleanly', async () => {
        const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql'));
        assert.deepEqual(await migrate(db.url), []);
        assert.equal((await migrate(db.url, 'down')).length, files.length);
        const tables = await db.pool.query(`select 1 from pg_tables where schemaname = 'public' and tablename <> 'pgmigrations'`);
        assert.equal(tables.rowCount, 0);
        assert.equal((await migrate(db.url)).length, files.length);
    });
});
