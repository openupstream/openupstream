/**
 * The Secrets store: Secret values encrypted with their Project's data key
 * (./envelope.ts) in the control plane's Database.
 *
 * A Project's data key is created with its first Secret. Values never leave
 * this module except through readSecretValues, which the Secrets operator
 * uses to render the Project's Kubernetes Secret.
 */
import type pg from 'pg';
import type { Secret, SecretInput } from '@openupstream/sdk';
import { type Result, err, ok } from '../result.js';
import {
    type DataKey,
    type EnvelopeError,
    type KeyEncryptionKey,
    decryptSecretValue,
    encryptSecretValue,
    generateDataKey,
    unwrapDataKey,
    wrapDataKey,
} from './envelope.js';

export type Db = pg.Pool | pg.PoolClient;

/** An environment variable name; the schema enforces the same rule. */
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/;

export type SecretStoreError =
    | { readonly kind: 'project-not-found'; readonly projectId: string }
    | { readonly kind: 'invalid-name'; readonly name: string }
    | { readonly kind: 'envelope'; readonly projectId: string; readonly error: EnvelopeError };

interface SecretRow {
    id: string;
    project_id: string;
    name: string;
    created_at: Date;
    updated_at: Date;
}

const toSecret = (row: SecretRow): Secret => ({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
});

async function projectExists(db: Db, projectId: string): Promise<boolean> {
    const result = await db.query('select 1 from projects where id = $1', [projectId]);
    return result.rowCount === 1;
}

async function readDataKey(
    db: Db,
    kek: KeyEncryptionKey,
    projectId: string,
): Promise<Result<DataKey | undefined, SecretStoreError>> {
    const result = await db.query<{ kek_id: string; wrapped_key: Buffer }>(
        'select kek_id, wrapped_key from project_data_keys where project_id = $1',
        [projectId],
    );
    const row = result.rows[0];
    if (!row) {
        return ok(undefined);
    }
    const dataKey = unwrapDataKey(kek, { kekId: row.kek_id, wrapped: row.wrapped_key }, projectId);
    return dataKey.ok ? dataKey : err({ kind: 'envelope', projectId, error: dataKey.error });
}

/** The Project's data key, created on first use. Safe against concurrent first use. */
async function dataKeyFor(db: Db, kek: KeyEncryptionKey, projectId: string): Promise<Result<DataKey, SecretStoreError>> {
    const existing = await readDataKey(db, kek, projectId);
    if (!existing.ok) {
        return existing;
    }
    if (existing.value) {
        return ok(existing.value);
    }
    const wrapped = wrapDataKey(kek, generateDataKey(), projectId);
    await db.query(
        `insert into project_data_keys (project_id, kek_id, wrapped_key) values ($1, $2, $3)
         on conflict (project_id) do nothing`,
        [projectId, wrapped.kekId, wrapped.wrapped],
    );
    const stored = await readDataKey(db, kek, projectId);
    if (!stored.ok) {
        return stored;
    }
    return stored.value ? ok(stored.value) : err({ kind: 'project-not-found', projectId });
}

/** Creates the Secret or replaces its value. */
export async function putSecret(
    db: Db,
    kek: KeyEncryptionKey,
    projectId: string,
    input: SecretInput,
): Promise<Result<Secret, SecretStoreError>> {
    if (!SECRET_NAME.test(input.name)) {
        return err({ kind: 'invalid-name', name: input.name });
    }
    if (!(await projectExists(db, projectId))) {
        return err({ kind: 'project-not-found', projectId });
    }
    const dataKey = await dataKeyFor(db, kek, projectId);
    if (!dataKey.ok) {
        return dataKey;
    }
    const ciphertext = encryptSecretValue(dataKey.value, { projectId, name: input.name }, input.value);
    const result = await db.query<SecretRow>(
        `insert into secrets (project_id, name, ciphertext) values ($1, $2, $3)
         on conflict (project_id, name) do update set ciphertext = excluded.ciphertext, updated_at = now()
         returning id, project_id, name, created_at, updated_at`,
        [projectId, input.name, ciphertext],
    );
    const row = result.rows[0];
    return row ? ok(toSecret(row)) : err({ kind: 'project-not-found', projectId });
}

/** The Project's Secrets, without values. */
export async function listSecrets(db: Db, projectId: string): Promise<readonly Secret[]> {
    const result = await db.query<SecretRow>(
        'select id, project_id, name, created_at, updated_at from secrets where project_id = $1 order by name',
        [projectId],
    );
    return result.rows.map(toSecret);
}

/** Deletes the Secret; false if it did not exist. */
export async function deleteSecret(db: Db, projectId: string, name: string): Promise<boolean> {
    const result = await db.query('delete from secrets where project_id = $1 and name = $2', [projectId, name]);
    return result.rowCount === 1;
}

/** Every Secret of the Project, decrypted: name → value. */
export async function readSecretValues(
    db: Db,
    kek: KeyEncryptionKey,
    projectId: string,
): Promise<Result<ReadonlyMap<string, string>, SecretStoreError>> {
    const dataKey = await readDataKey(db, kek, projectId);
    if (!dataKey.ok) {
        return dataKey;
    }
    if (!dataKey.value) {
        return ok(new Map());
    }
    const result = await db.query<{ name: string; ciphertext: Buffer }>(
        'select name, ciphertext from secrets where project_id = $1 order by name',
        [projectId],
    );
    const values = new Map<string, string>();
    for (const row of result.rows) {
        const value = decryptSecretValue(dataKey.value, { projectId, name: row.name }, row.ciphertext);
        if (!value.ok) {
            return err({ kind: 'envelope', projectId, error: value.error });
        }
        values.set(row.name, value.value);
    }
    return ok(values);
}
