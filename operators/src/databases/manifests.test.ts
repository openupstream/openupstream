import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Database, Project, Site } from '@openupstream/sdk';
import { LABELS, THIRD_SITE, THIRD_SITE_TAINT, ZONE_LABEL } from '../kubernetes.js';
import {
    BACKUP_CREDENTIAL_KEYS,
    BACKUP_ENDPOINT,
    BARMAN_CLOUD_PLUGIN,
    type DatabaseConfig,
    type DatabaseManifests,
    databaseManifests,
    restoredDatabaseManifests,
} from './manifests.js';

const project: Project = {
    id: '0b8e6c9e-7a4f-4e39-9a7e-1f3f0d6f2a11',
    accountId: '9c4f1d2e-3b5a-4c6d-8e7f-0a1b2c3d4e5f',
    name: 'shop-prod',
    createdAt: '2026-10-17T00:00:00Z',
};

const database: Database = {
    id: '5d1c2a33-90b4-4c8f-8f3e-6c2b9d0e7f44',
    projectId: project.id,
    name: 'orders',
    homeSite: 'hetzner-fsn1',
    memoryMb: 512,
    storageGb: 10,
    createdAt: '2026-10-17T00:00:00Z',
};

const config: DatabaseConfig = {
    postgresImage: 'ghcr.io/openupstream/postgres@sha256:0000000000000000000000000000000000000000000000000000000000000000',
    storageClass: 'topolvm-provisioner',
    backup: { bucket: 'openupstream-backups', credentialsSecret: 'backup-s3', retention: '30d', schedule: '0 0 3 * * *' },
};

const manifestsFor = (overrides: Partial<Database> = {}): DatabaseManifests => {
    const result = databaseManifests(project, { ...database, ...overrides }, config);
    assert.ok(result.ok, JSON.stringify(!result.ok && result.error));
    return result.value;
};

const errorsFor = (overrides: Partial<Database>, owner: Project = project) => {
    const result = databaseManifests(owner, { ...database, ...overrides }, config);
    assert.equal(result.ok, false);
    return result.ok ? [] : result.error;
};

interface Toleration {
    key?: string;
    operator?: string;
    value?: string;
    effect?: string;
}

/** Kubernetes' rule for whether a toleration tolerates a taint. */
const tolerates = (toleration: Toleration, taint: { key: string; value: string; effect: string }): boolean =>
    (toleration.effect === undefined || toleration.effect === '' || toleration.effect === taint.effect) &&
    (toleration.operator === 'Exists'
        ? toleration.key === undefined || toleration.key === '' || toleration.key === taint.key
        : toleration.key === taint.key && (toleration.value ?? '') === taint.value);

/** The Sites a required node affinity admits, given every node's zone label. */
const admittedSites = (affinity: unknown): string[] => {
    const terms = (affinity as { nodeSelectorTerms: { matchExpressions: { key: string; operator: string; values: string[] }[] }[] })
        .nodeSelectorTerms;
    return ['hetzner-fsn1', 'ovh-lim', THIRD_SITE].filter((site) =>
        terms.some((term) =>
            term.matchExpressions.every((e) => e.key === ZONE_LABEL && e.operator === 'In' && e.values.includes(site)),
        ),
    );
};

test('a Database runs as a Cluster of two instances', () => {
    const { cluster } = manifestsFor();
    assert.equal(cluster.apiVersion, 'postgresql.cnpg.io/v1');
    assert.equal(cluster.kind, 'Cluster');
    assert.equal(cluster.spec.instances, 2);
    assert.equal(cluster.spec.imageName, config.postgresImage);
});

test('the two instances never share a Site', () => {
    const affinity = manifestsFor().cluster.spec.affinity;
    assert.equal(affinity?.enablePodAntiAffinity, true);
    assert.equal(affinity?.podAntiAffinityType, 'required');
    assert.equal(affinity?.topologyKey, 'topology.kubernetes.io/zone');
});

for (const homeSite of ['hetzner-fsn1', 'ovh-lim'] as const satisfies readonly Site[]) {
    test(`the primary is placed in the Home site ${homeSite}`, () => {
        const preferred = manifestsFor({ homeSite }).cluster.spec.affinity?.nodeAffinity
            ?.preferredDuringSchedulingIgnoredDuringExecution;
        assert.deepEqual(preferred, [
            { weight: 100, preference: { matchExpressions: [{ key: ZONE_LABEL, operator: 'In', values: [homeSite] }] } },
        ]);
    });
}

test('instances and poolers may only run in the compute Sites', () => {
    const { cluster, pooler } = manifestsFor();
    const clusterRequired = cluster.spec.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution;
    const poolerRequired = pooler.spec.template?.spec?.affinity?.nodeAffinity?.requiredDuringSchedulingIgnoredDuringExecution;
    assert.deepEqual(admittedSites(clusterRequired), ['hetzner-fsn1', 'ovh-lim']);
    assert.deepEqual(admittedSites(poolerRequired), ['hetzner-fsn1', 'ovh-lim']);
});

test("nothing tolerates the third Site's taint", () => {
    const { cluster, pooler } = manifestsFor();
    const tolerations: Toleration[] = [
        ...(cluster.spec.affinity?.tolerations ?? []),
        ...(pooler.spec.template?.spec?.tolerations ?? []),
    ];
    assert.equal(
        tolerations.some((t) => tolerates(t, THIRD_SITE_TAINT)),
        false,
    );
    // The check itself: a blanket toleration would have been caught.
    assert.equal(tolerates({ operator: 'Exists' }, THIRD_SITE_TAINT), true);
});

test('memory is reserved at the configured size and buffers scale with it', () => {
    const { cluster } = manifestsFor({ memoryMb: 1024 });
    assert.deepEqual(cluster.spec.resources, { requests: { memory: '1024Mi' }, limits: { memory: '1024Mi' } });
    assert.equal(cluster.spec.postgresql?.parameters?.['shared_buffers'], '256MB');
});

test('256 MB is the memory floor', () => {
    assert.deepEqual(manifestsFor({ memoryMb: 256 }).cluster.spec.resources?.limits, { memory: '256Mi' });
    assert.deepEqual(errorsFor({ memoryMb: 255 }), [{ kind: 'memory-below-floor', memoryMb: 255, minimumMb: 256 }]);
    assert.deepEqual(errorsFor({ memoryMb: 1024.5 }), [{ kind: 'invalid-memory', memoryMb: 1024.5 }]);
    assert.deepEqual(errorsFor({ memoryMb: Number.NaN }), [{ kind: 'invalid-memory', memoryMb: Number.NaN }]);
});

test('storage is a resizable TopoLVM volume of the configured size', () => {
    assert.deepEqual(manifestsFor({ storageGb: 25 }).cluster.spec.storage, {
        storageClass: 'topolvm-provisioner',
        size: '25Gi',
        resizeInUseVolumes: true,
    });
    assert.deepEqual(errorsFor({ storageGb: 0 }), [{ kind: 'invalid-storage', storageGb: 0 }]);
});

test('pgvector is created in the application database', () => {
    assert.deepEqual(manifestsFor().cluster.spec.bootstrap?.initdb?.postInitApplicationSQL, [
        'CREATE EXTENSION IF NOT EXISTS vector',
    ]);
});

test('PgBouncer follows the primary, one per Site', () => {
    const { cluster, pooler } = manifestsFor();
    assert.equal(pooler.kind, 'Pooler');
    assert.equal(pooler.spec.type, 'rw');
    assert.deepEqual(pooler.spec.cluster, { name: cluster.metadata.name });
    assert.equal(pooler.spec.instances, 2);
    assert.deepEqual(pooler.spec.pgbouncer.poolMode, 'transaction');
    assert.deepEqual(pooler.spec.template?.spec?.containers, []);
    assert.deepEqual(pooler.spec.template?.spec?.affinity?.podAntiAffinity?.requiredDuringSchedulingIgnoredDuringExecution, [
        { labelSelector: { matchLabels: { 'cnpg.io/poolerName': pooler.metadata.name } }, topologyKey: ZONE_LABEL },
    ]);
});

test('PgBouncer drops connections to a primary in a dark Site within seconds', () => {
    const parameters = manifestsFor().pooler.spec.pgbouncer.parameters ?? {};
    assert.equal(parameters.max_prepared_statements, '200');
    assert.equal(parameters.tcp_keepalive, '1');
    // Idle: probes after 10 s, every 5 s, 3 misses: dropped after 25 s.
    assert.equal(Number(parameters.tcp_keepidle) + Number(parameters.tcp_keepintvl) * Number(parameters.tcp_keepcnt), 25);
    assert.equal(parameters.tcp_user_timeout, '10000');
    assert.equal(parameters.server_connect_timeout, '5');
});

test("the Pooler's name clashes with none of the Cluster's", () => {
    const { cluster, pooler } = manifestsFor();
    const clusterServices = ['rw', 'ro', 'r'].map((suffix) => `${cluster.metadata.name}-${suffix}`);
    assert.equal([cluster.metadata.name, ...clusterServices].includes(pooler.metadata.name), false);
});

test('WAL is archived to Hetzner Object Storage NBG1 through the Barman Cloud Plugin', () => {
    const { cluster, objectStore } = manifestsFor();
    assert.equal(objectStore.apiVersion, 'barmancloud.cnpg.io/v1');
    assert.equal(objectStore.kind, 'ObjectStore');
    assert.equal(BACKUP_ENDPOINT, 'https://nbg1.your-objectstorage.com');
    assert.equal(objectStore.spec.configuration.endpointURL, BACKUP_ENDPOINT);
    assert.deepEqual(objectStore.spec.configuration.s3Credentials, {
        accessKeyId: { name: 'backup-s3', key: BACKUP_CREDENTIAL_KEYS.accessKeyId },
        secretAccessKey: { name: 'backup-s3', key: BACKUP_CREDENTIAL_KEYS.secretAccessKey },
    });
    assert.equal(objectStore.spec.retentionPolicy, '30d');
    assert.deepEqual(cluster.spec.plugins, [
        { name: BARMAN_CLOUD_PLUGIN, isWALArchiver: true, parameters: { barmanObjectName: objectStore.metadata.name } },
    ]);
});

test('each Database archives into its own folder, named by ids', () => {
    const { objectStore } = manifestsFor();
    assert.equal(objectStore.spec.configuration.destinationPath, `s3://openupstream-backups/project-${project.id}`);
    // Barman appends the Cluster's name.
    assert.equal(objectStore.metadata.name, `db-${database.id}`);
});

test('base backups are scheduled through the plugin, the first one at once', () => {
    const { cluster, scheduledBackup } = manifestsFor();
    assert.equal(scheduledBackup.kind, 'ScheduledBackup');
    assert.deepEqual(scheduledBackup.spec, {
        cluster: { name: cluster.metadata.name },
        schedule: '0 0 3 * * *',
        method: 'plugin',
        pluginConfiguration: { name: BARMAN_CLOUD_PLUGIN },
        immediate: true,
        target: 'prefer-standby',
        backupOwnerReference: 'self',
    });
});

test("everything lives in the Project's namespace, named by ids, labelled with names", () => {
    const manifests = manifestsFor();
    const objects = [manifests.objectStore, manifests.cluster, manifests.pooler, manifests.scheduledBackup];
    for (const object of objects) {
        assert.equal(object.metadata.namespace, `project-${project.id}`);
        assert.equal(object.metadata.labels[LABELS.projectId], project.id);
        assert.equal(object.metadata.labels[LABELS.projectName], 'shop-prod');
        assert.equal(object.metadata.labels[LABELS.databaseId], database.id);
        assert.equal(object.metadata.labels[LABELS.databaseName], 'orders');
    }
    assert.equal(manifests.cluster.metadata.name, `db-${database.id}`);
    assert.equal(manifests.pooler.metadata.name, `db-${database.id}-pooler`);
    assert.equal(manifests.cluster.metadata.labels[LABELS.managedBy], 'openupstream-operators');
    // CloudNativePG sets managed-by on what it creates; everything else is passed on.
    const { [LABELS.managedBy]: _, ...passedOn } = manifests.cluster.metadata.labels;
    assert.deepEqual(manifests.cluster.spec.inheritedMetadata?.labels, passedOn);
    assert.deepEqual(manifests.pooler.spec.template?.metadata?.labels, passedOn);
});

test('names stay within the Kubernetes and CloudNativePG limits', () => {
    const { cluster, pooler, scheduledBackup } = manifestsFor();
    assert.ok(cluster.metadata.name.length <= 50, 'CloudNativePG rejects longer Cluster names');
    assert.match(cluster.metadata.name, /^[a-z]([-a-z0-9]*[a-z0-9])?$/);
    assert.ok(pooler.metadata.name.length <= 63);
    // Backups are named <scheduled backup>-<YYYYMMDDhhmmss>.
    assert.ok(`${scheduledBackup.metadata.name}-20261017030000`.length <= 63);
});

test('a Home site outside the compute Sites is rejected', () => {
    assert.deepEqual(errorsFor({ homeSite: THIRD_SITE as Site }), [{ kind: 'not-a-compute-site', value: THIRD_SITE }]);
});

test('ids must be lowercase UUIDs and the Database must belong to the Project', () => {
    const upper = database.id.toUpperCase();
    assert.deepEqual(errorsFor({ id: upper }), [{ kind: 'invalid-id', field: 'database.id', value: upper }]);
    assert.deepEqual(errorsFor({ projectId: '7e6d5c4b-3a29-4180-9f8e-7d6c5b4a3928' }), [
        { kind: 'project-mismatch', projectId: project.id, databaseProjectId: '7e6d5c4b-3a29-4180-9f8e-7d6c5b4a3928' },
    ]);
});

test('names must be usable as label values', () => {
    assert.deepEqual(errorsFor({ name: 'Orders' }), [{ kind: 'invalid-name', field: 'database.name', value: 'Orders' }]);
    assert.deepEqual(errorsFor({}, { ...project, name: 'shop_prod' }), [
        { kind: 'invalid-name', field: 'project.name', value: 'shop_prod' },
    ]);
});

test('every problem is reported at once', () => {
    const kinds = errorsFor({ memoryMb: 128, storageGb: -1, homeSite: THIRD_SITE as Site }).map((e) => e.kind);
    assert.deepEqual(kinds, ['not-a-compute-site', 'memory-below-floor', 'invalid-storage']);
});

test('the same Database always gives the same objects and is left untouched', () => {
    const frozen = Object.freeze({ ...database });
    const first = databaseManifests(project, frozen, config);
    assert.deepEqual(databaseManifests(project, frozen, config), first);
    assert.deepEqual(frozen, database);
});

const restoredDatabase: Database = { ...database, id: 'a7c4e2f1-3d5b-4c6e-8f9a-0b1c2d3e4f5a', name: 'orders-restored' };
const source = { database, targetTime: '2026-10-17T10:30:00Z' };

test("a restored Database replays the source's archive up to the target time", () => {
    const result = restoredDatabaseManifests(project, restoredDatabase, config, source);
    assert.ok(result.ok, JSON.stringify(!result.ok && result.error));
    const { cluster, objectStore } = result.value;
    assert.deepEqual(cluster.spec.bootstrap, {
        recovery: { source: 'origin', recoveryTarget: { targetTime: '2026-10-17T10:30:00Z' } },
    });
    assert.deepEqual(cluster.spec.externalClusters, [
        {
            name: 'origin',
            plugin: {
                name: BARMAN_CLOUD_PLUGIN,
                parameters: { barmanObjectName: `db-${database.id}`, serverName: `db-${database.id}` },
            },
        },
    ]);
    // It archives into its own folder, never into the source's.
    assert.equal(objectStore.metadata.name, `db-${restoredDatabase.id}`);
    assert.deepEqual(cluster.spec.plugins?.[0]?.parameters, { barmanObjectName: `db-${restoredDatabase.id}` });
});

test('everything else about a restored Database is that of a new one', () => {
    const restored = restoredDatabaseManifests(project, restoredDatabase, config, source);
    const fresh = databaseManifests(project, restoredDatabase, config);
    assert.ok(restored.ok && fresh.ok);
    const { bootstrap: _restoredBootstrap, externalClusters: _sources, ...restoredSpec } = restored.value.cluster.spec;
    const { bootstrap: _freshBootstrap, ...freshSpec } = fresh.value.cluster.spec;
    assert.deepEqual(restoredSpec, freshSpec);
    assert.deepEqual(restored.value.pooler, fresh.value.pooler);
    assert.deepEqual(restored.value.scheduledBackup, fresh.value.scheduledBackup);
});

test('a restore cannot target its own source, a malformed id or a time without a zone', () => {
    const result = restoredDatabaseManifests(project, database, config, {
        database,
        targetTime: '2026-10-17 10:30:00',
    });
    assert.deepEqual(result.ok ? [] : result.error, [
        { kind: 'restore-into-source', databaseId: database.id },
        { kind: 'invalid-target-time', value: '2026-10-17 10:30:00' },
    ]);
    const badId = restoredDatabaseManifests(project, restoredDatabase, config, {
        ...source,
        database: { ...database, id: 'orders' },
    });
    assert.deepEqual(badId.ok ? [] : badId.error, [{ kind: 'invalid-id', field: 'source.databaseId', value: 'orders' }]);
});

test("a restored Database's own problems are reported with the source's", () => {
    const result = restoredDatabaseManifests(project, { ...restoredDatabase, memoryMb: 128 }, config, {
        ...source,
        targetTime: 'yesterday',
    });
    assert.deepEqual(
        result.ok ? [] : result.error.map((error) => error.kind),
        ['memory-below-floor', 'invalid-target-time'],
    );
});

test('a restore reads only an archive of its own Project', () => {
    const otherProject = '7e6d5c4b-3a29-4180-9f8e-7d6c5b4a3928';
    const result = restoredDatabaseManifests(project, restoredDatabase, config, {
        ...source,
        database: { ...database, projectId: otherProject },
    });
    assert.deepEqual(result.ok ? [] : result.error, [
        { kind: 'source-in-other-project', projectId: project.id, sourceProjectId: otherProject },
    ]);
});

test('target times must exist on the calendar', () => {
    for (const targetTime of ['2026-02-30T10:00:00Z', '2026-13-01T10:00:00Z', '2026-10-17T24:00:00Z', '2026-10-17T10:60:00Z']) {
        const result = restoredDatabaseManifests(project, restoredDatabase, config, { ...source, targetTime });
        assert.deepEqual(result.ok ? [] : result.error, [{ kind: 'invalid-target-time', value: targetTime }], targetTime);
    }
    for (const targetTime of ['2028-02-29T10:00:00Z', '2026-10-17T10:30:00.123+02:00', '2026-12-31T23:59:59-05:30']) {
        assert.ok(restoredDatabaseManifests(project, restoredDatabase, config, { ...source, targetTime }).ok, targetTime);
    }
});
