import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Database, Project } from '@openupstream/sdk';
import type { Kube, KubeError, KubeObject } from '../kube.js';
import { LABELS, MANAGED_BY } from '../kubernetes.js';
import { type Result, err, ok } from '../result.js';
import type { DatabaseConfig } from './manifests.js';
import { type DatabaseRow, planDatabases, reconcileDatabases } from './reconcile.js';

const project: Project = {
    id: '0b8e6c9e-7a4f-4e39-9a7e-1f3f0d6f2a11',
    accountId: '9c4f1d2e-3b5a-4c6d-8e7f-0a1b2c3d4e5f',
    name: 'shop-prod',
    createdAt: '2026-10-17T00:00:00Z',
};

const database = (id: string, name: string, overrides: Partial<Database> = {}): Database => ({
    id,
    projectId: project.id,
    name,
    homeSite: 'hetzner-fsn1',
    memoryMb: 512,
    storageGb: 10,
    createdAt: '2026-10-17T00:00:00Z',
    ...overrides,
});

const orders = database('5d1c2a33-90b4-4c8f-8f3e-6c2b9d0e7f44', 'orders');
const invoices = database('7a2e4b55-1c3d-4e6f-8a9b-0c1d2e3f4a5b', 'invoices');

const config: DatabaseConfig = {
    postgresImage: 'ghcr.io/openupstream/postgres@sha256:0000000000000000000000000000000000000000000000000000000000000000',
    storageClass: 'topolvm-provisioner',
    backup: { bucket: 'openupstream-backups', credentialsSecret: 'backup-s3', retention: '30d', schedule: '0 0 3 * * *' },
};

const credentials = { ACCESS_KEY_ID: 'aWQ=', ACCESS_SECRET_KEY: 'c2VjcmV0' };
const namespace = `project-${project.id}`;

const kinds = (objects: readonly KubeObject[]) => objects.map((object) => object.kind);

test('a Project with two Databases gets one namespace, one credentials Secret and four objects per Database', () => {
    const rows: DatabaseRow[] = [
        { project, database: orders },
        { project, database: invoices },
    ];
    const plan = planDatabases(rows, config, credentials);
    assert.deepEqual(kinds(plan.apply), [
        'Namespace',
        'Secret',
        'ObjectStore',
        'Cluster',
        'Pooler',
        'ScheduledBackup',
        'ObjectStore',
        'Cluster',
        'Pooler',
        'ScheduledBackup',
    ]);
    assert.deepEqual(plan.invalid, []);
});

test("the backup credentials are copied into the Project's namespace under the name the ObjectStore uses", () => {
    const plan = planDatabases([{ project, database: orders }], config, credentials);
    const secret = plan.apply.find((object) => object.kind === 'Secret');
    assert.deepEqual(secret?.metadata, {
        name: 'backup-s3',
        namespace,
        labels: { [LABELS.projectId]: project.id, [LABELS.managedBy]: MANAGED_BY },
    });
    assert.deepEqual(secret?.['data'], credentials);
    const namespaceObject = plan.apply.find((object) => object.kind === 'Namespace');
    assert.equal(namespaceObject?.metadata.name, namespace);
    assert.equal(namespaceObject?.metadata.labels?.[LABELS.projectName], 'shop-prod');
});

test('an invalid row is reported and applies nothing, the others still apply', () => {
    const broken = database('1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b', 'broken', { memoryMb: 64 });
    const plan = planDatabases(
        [
            { project, database: broken },
            { project, database: orders },
        ],
        config,
        credentials,
    );
    assert.deepEqual(
        plan.invalid.map(({ databaseId, errors }) => ({ databaseId, kinds: errors.map((error) => error.kind) })),
        [{ databaseId: broken.id, kinds: ['memory-below-floor'] }],
    );
    const clusters = plan.apply.filter((object) => object.kind === 'Cluster');
    assert.deepEqual(
        clusters.map((object) => object.metadata.name),
        [`db-${orders.id}`],
    );
});

test('no rows: nothing to apply', () => {
    assert.deepEqual(planDatabases([], config, credentials), { apply: [], invalid: [] });
});

/** Records what the reconcile pass sends; fails applies for the given kinds. */
const fakeKube = (secret: Record<string, string> | undefined, failKinds: readonly string[] = []) => {
    const applied: { object: KubeObject; dryRun: boolean }[] = [];
    const kube: Kube = {
        apply: async (object, { dryRun }): Promise<Result<void, KubeError>> => {
            applied.push({ object, dryRun });
            return failKinds.includes(object.kind) ? err({ status: 422, message: 'invalid' }) : ok(undefined);
        },
        readSecret: async () => ok(secret),
    };
    return { kube, applied };
};

const options = { backupCredentials: { namespace: 'openupstream-system', name: 'backup-s3' } };

test('reconcile applies the plan in order and reports each object', async () => {
    const { kube, applied } = fakeKube(credentials);
    const result = await reconcileDatabases(kube, [{ project, database: orders }], config, options);
    assert.ok(result.ok);
    assert.deepEqual(kinds(applied.map(({ object }) => object)), [
        'Namespace',
        'Secret',
        'ObjectStore',
        'Cluster',
        'Pooler',
        'ScheduledBackup',
    ]);
    assert.equal(result.value.applied.length, 6);
    assert.deepEqual(result.value.failed, []);
    assert.equal(
        applied.every(({ dryRun }) => !dryRun),
        true,
    );
});

test('reconcile passes the dry run on to every apply', async () => {
    const { kube, applied } = fakeKube(credentials);
    await reconcileDatabases(kube, [{ project, database: orders }], config, { ...options, dryRun: true });
    assert.equal(
        applied.every(({ dryRun }) => dryRun),
        true,
    );
});

test('a failed apply is reported and the pass goes on', async () => {
    const { kube, applied } = fakeKube(credentials, ['Cluster']);
    const result = await reconcileDatabases(kube, [{ project, database: orders }], config, options);
    assert.ok(result.ok);
    assert.equal(applied.length, 6);
    assert.deepEqual(result.value.failed, [
        {
            ref: { apiVersion: 'postgresql.cnpg.io/v1', kind: 'Cluster', namespace, name: `db-${orders.id}` },
            error: { status: 422, message: 'invalid' },
        },
    ]);
});

test('without the backup credentials Secret nothing is applied', async () => {
    const { kube, applied } = fakeKube(undefined);
    const result = await reconcileDatabases(kube, [{ project, database: orders }], config, options);
    assert.deepEqual(result, {
        ok: false,
        error: { kind: 'missing-backup-credentials', namespace: 'openupstream-system', name: 'backup-s3' },
    });
    assert.equal(applied.length, 0);
});
