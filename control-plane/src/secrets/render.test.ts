import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { ControlPlaneKube, SecretManifest } from '../kube.js';
import { err, ok } from '../result.js';
import { type TestDatabase, createTestDatabase } from '../testing/postgres.js';
import type { KeyEncryptionKey } from './envelope.js';
import { projectSecretManifest, secretsPass } from './render.js';
import { deleteSecret, putSecret } from './store.js';

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

/** Records applied Secrets by namespace; `failing` namespaces answer an error, `missing` ones have no namespace. */
const fakeKube = (failing: readonly string[] = [], missing: readonly string[] = []) => {
    const applied = new Map<string, SecretManifest>();
    const kube: ControlPlaneKube = {
        readCluster: async () => ok(undefined),
        remove: async () => ok(undefined),
        applySecret: async (secret) => {
            if (failing.includes(secret.metadata.namespace)) {
                return err('forbidden');
            }
            if (missing.includes(secret.metadata.namespace)) {
                return ok('no-namespace');
            }
            applied.set(secret.metadata.namespace, secret);
            return ok('applied');
        },
    };
    return { kube, applied };
};

test("the manifest holds every value base64 encoded, in the Project's namespace", () => {
    const secret = projectSecretManifest('11111111-1111-4111-8111-111111111111', new Map([['A', 'ä b']]));
    assert.equal(secret.metadata.name, 'project-secrets');
    assert.equal(secret.metadata.namespace, 'project-11111111-1111-4111-8111-111111111111');
    assert.deepEqual(secret.data, { A: Buffer.from('ä b').toString('base64') });
});

test('a pass writes every live Project that had Secrets, an emptied one too, and goes on past a failure', async () => {
    const [withValues, emptied, failing, deleted, without] = [
        await createProject(),
        await createProject(),
        await createProject(),
        await createProject(),
        await createProject(),
    ];
    for (const projectId of [withValues, emptied, failing, deleted]) {
        assert.ok((await putSecret(db.pool, kek, projectId, { name: 'TOKEN', value: `v-${projectId}` })).ok);
    }
    assert.ok(await deleteSecret(db.pool, emptied, 'TOKEN'));
    await db.pool.query('update projects set deleted_at = now() where id = $1', [deleted]);

    const logs: Record<string, unknown>[] = [];
    const { kube, applied } = fakeKube([`project-${failing}`]);
    await secretsPass({ pool: db.pool, kube, kek, log: (entry) => logs.push(entry) });

    assert.deepEqual(applied.get(`project-${withValues}`)?.data, { TOKEN: Buffer.from(`v-${withValues}`).toString('base64') });
    assert.deepEqual(applied.get(`project-${emptied}`)?.data, {});
    assert.ok(!applied.has(`project-${deleted}`));
    assert.ok(!applied.has(`project-${without}`));
    assert.deepEqual(logs.find((entry) => entry['msg'] === 'cannot write the Secrets of a Project'), {
        msg: 'cannot write the Secrets of a Project',
        projectId: failing,
        error: 'forbidden',
    });
    assert.equal(logs.at(-1)?.['failed'], 1);
});
