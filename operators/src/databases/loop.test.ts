import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLATFORM } from '@openupstream/sdk';
import type { FetchRows } from '../control-plane.js';
import type { Kube } from '../kube.js';
import { err, ok } from '../result.js';
import { type PassLog, databasesPass, runDatabasesOperator } from './loop.js';
import type { DatabaseConfig } from './manifests.js';

const config: DatabaseConfig = {
    postgresImage: 'ghcr.io/cloudnative-pg/postgresql:17-standard-trixie',
    storageClass: 'local-path',
    backup: { bucket: 'b', credentialsSecret: 'backup-s3', retention: '7d', schedule: '0 0 3 * * *' },
};
const options = { backupCredentials: { namespace: 'openupstream-system', name: 'backup-s3' } };
const credentials = { ACCESS_KEY_ID: 'aWQ=', ACCESS_SECRET_KEY: 'c2VjcmV0' };

const kube = (applied: string[] = []): Kube => ({
    apply: async (object) => {
        applied.push(object.kind);
        return ok(undefined);
    },
    readSecret: async () => ok(credentials),
});

const platformRows: FetchRows = async () => ok([{ project: PLATFORM.project, database: PLATFORM.database }]);

test('a pass applies what the control plane lists and logs a summary', async () => {
    const applied: string[] = [];
    assert.deepEqual(await databasesPass(platformRows, kube(applied), config, options), {
        msg: 'reconcile pass done',
        databases: 1,
        applied: 6,
    });
    assert.equal(applied.length, 6);
});

test('without rows nothing is applied: an unreachable control plane never means "no Databases"', async () => {
    const applied: string[] = [];
    const down: FetchRows = async () => err({ kind: 'unreachable', message: 'ECONNREFUSED' });
    assert.deepEqual(await databasesPass(down, kube(applied), config, options), {
        msg: 'cannot get Database rows',
        error: { kind: 'unreachable', message: 'ECONNREFUSED' },
    });
    assert.deepEqual(applied, []);
});

test('invalid rows are logged', async () => {
    const broken: FetchRows = async () =>
        ok([{ project: PLATFORM.project, database: { ...PLATFORM.database, memoryMb: 64 } }]);
    const log = await databasesPass(broken, kube(), config, options);
    assert.equal(log.msg, 'reconcile pass done');
    assert.deepEqual(
        (log['invalid'] as { errors: { kind: string }[] }[])[0]?.errors.map((error) => error.kind),
        ['memory-below-floor'],
    );
});

test('the loop runs passes until it is stopped', async () => {
    const stop = new AbortController();
    const logs: PassLog[] = [];
    let passes = 0;
    await runDatabasesOperator(
        async () => {
            passes += 1;
            if (passes === 3) {
                stop.abort();
            }
            return { msg: `pass ${passes}` };
        },
        1,
        (entry) => logs.push(entry),
        stop.signal,
    );
    assert.deepEqual(
        logs.map((entry) => entry.msg),
        ['pass 1', 'pass 2', 'pass 3'],
    );
});
