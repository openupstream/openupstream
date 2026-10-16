import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { type TestDatabase, createTestDatabase } from '../testing/postgres.js';
import type { KeyEncryptionKey } from './envelope.js';
import { deleteSecret, listSecrets, putSecret, readSecretValues } from './store.js';

let db: TestDatabase;
const kek: KeyEncryptionKey = { id: 'kek-1', key: randomBytes(32) };

before(async () => {
    db = await createTestDatabase();
});

after(async () => {
    await db.close();
});

async function createProject(): Promise<string> {
    const account = await db.pool.query<{ id: string }>(`insert into accounts (name) values ('Acme') returning id`);
    const project = await db.pool.query<{ id: string }>(
        `insert into projects (account_id, name) values ($1, $2) returning id`,
        [account.rows[0]?.id, `p-${randomBytes(4).toString('hex')}`],
    );
    const id = project.rows[0]?.id;
    assert.ok(id);
    return id;
}

test('Secrets are stored encrypted and read back by name', async () => {
    const projectId = await createProject();
    const put = await putSecret(db.pool, kek, projectId, { name: 'DATABASE_URL', value: 'postgres://app:pw@db/app' });
    assert.ok(put.ok);
    assert.equal(put.value.name, 'DATABASE_URL');
    await putSecret(db.pool, kek, projectId, { name: 'API_KEY', value: 'k-123' });

    const stored = await db.pool.query<{ ciphertext: Buffer }>('select ciphertext from secrets where project_id = $1', [
        projectId,
    ]);
    for (const row of stored.rows) {
        assert.equal(row.ciphertext.includes(Buffer.from('postgres://')), false);
        assert.equal(row.ciphertext.includes(Buffer.from('k-123')), false);
    }

    assert.deepEqual(
        (await listSecrets(db.pool, projectId)).map((secret) => secret.name),
        ['API_KEY', 'DATABASE_URL'],
    );
    const values = await readSecretValues(db.pool, kek, projectId);
    assert.ok(values.ok);
    assert.deepEqual(
        [...values.value],
        [
            ['API_KEY', 'k-123'],
            ['DATABASE_URL', 'postgres://app:pw@db/app'],
        ],
    );
});

test('putting a Secret again replaces its value and keeps one data key', async () => {
    const projectId = await createProject();
    const first = await putSecret(db.pool, kek, projectId, { name: 'TOKEN', value: 'old' });
    const second = await putSecret(db.pool, kek, projectId, { name: 'TOKEN', value: 'new' });
    assert.ok(first.ok && second.ok);
    assert.equal(second.value.id, first.value.id);

    const values = await readSecretValues(db.pool, kek, projectId);
    assert.ok(values.ok);
    assert.equal(values.value.get('TOKEN'), 'new');
    const keys = await db.pool.query('select 1 from project_data_keys where project_id = $1', [projectId]);
    assert.equal(keys.rowCount, 1);
});

test('concurrent first Secrets of a Project share one data key', async () => {
    const projectId = await createProject();
    const results = await Promise.all(
        ['A', 'B', 'C', 'D'].map((name) => putSecret(db.pool, kek, projectId, { name, value: name.toLowerCase() })),
    );
    assert.ok(results.every((result) => result.ok));
    const values = await readSecretValues(db.pool, kek, projectId);
    assert.ok(values.ok);
    assert.deepEqual(Object.fromEntries(values.value), { A: 'a', B: 'b', C: 'c', D: 'd' });
});

test('Secrets are not readable with another KEK', async () => {
    const projectId = await createProject();
    await putSecret(db.pool, kek, projectId, { name: 'TOKEN', value: 'x' });
    const other = await readSecretValues(db.pool, { id: 'kek-2', key: randomBytes(32) }, projectId);
    assert.deepEqual(other, {
        ok: false,
        error: { kind: 'envelope', projectId, error: { kind: 'kek-mismatch', expected: 'kek-1', actual: 'kek-2' } },
    });
});

test('a Secret needs an environment variable name and an existing Project', async () => {
    const projectId = await createProject();
    assert.deepEqual(await putSecret(db.pool, kek, projectId, { name: '1PASSWORD', value: 'x' }), {
        ok: false,
        error: { kind: 'invalid-name', name: '1PASSWORD' },
    });
    const missing = randomUUID();
    assert.deepEqual(await putSecret(db.pool, kek, missing, { name: 'TOKEN', value: 'x' }), {
        ok: false,
        error: { kind: 'project-not-found', projectId: missing },
    });
});

test('a Project without Secrets reads as empty; deleted Secrets are gone', async () => {
    const projectId = await createProject();
    const empty = await readSecretValues(db.pool, kek, projectId);
    assert.ok(empty.ok);
    assert.equal(empty.value.size, 0);

    await putSecret(db.pool, kek, projectId, { name: 'TOKEN', value: 'x' });
    assert.equal(await deleteSecret(db.pool, projectId, 'TOKEN'), true);
    assert.equal(await deleteSecret(db.pool, projectId, 'TOKEN'), false);
    assert.deepEqual(await listSecrets(db.pool, projectId), []);
});
