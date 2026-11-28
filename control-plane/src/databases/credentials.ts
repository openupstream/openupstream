/**
 * A Database's `app` user (ARCHITECTURE.md, decision 156).
 *
 * The control plane generates its password when the Database is created,
 * seals it with the Project's data key and renders two Secrets from it
 * (secrets/render.ts): the one the Project's Services and Jobs read the
 * password from, and one with its SCRAM verifier, which the Database's
 * Cluster names as its application Secret.
 *
 * Why not leave it to CloudNativePG, which generates a password when no
 * Secret is named: its instance manager sets the password again whenever
 * an instance becomes primary (a restart, a switchover, a failover). A
 * cleartext password it encodes with a new random salt each time, and
 * PgBouncer, which logs in to Postgres with the keys of the client's own
 * login, then fails its next login: the client waiting for it is
 * disconnected (dev cluster, 2026-11-28). A verifier is applied as it is,
 * so nothing changes and the Pooler's clients can be held through a
 * restart (decision 152).
 */
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { type Id, databaseAppSecret, databaseAppVerifierSecret, projectNamespace } from '@openupstream/sdk';
import type pg from 'pg';
import type { SecretManifest } from '../kube.js';
import { type Result, ok } from '../result.js';
import type { KeyEncryptionKey } from '../secrets/envelope.js';
import { type SecretStoreError, openProjectValue, sealProjectValue } from '../secrets/store.js';
import { generatePassword } from './roles.js';

/** The `app` user, as CloudNativePG names the application database's owner. */
export const APP_USER = 'app';

/** Postgres's own default for `scram_iterations`. */
const SCRAM_ITERATIONS = 4096;

const hmac = (key: Buffer, text: string): Buffer => createHmac('sha256', key).update(text).digest();

/**
 * The SCRAM-SHA-256 verifier Postgres stores for `password` (RFC 5802, as
 * in `pg_authid.rolpassword`). The password must need no SASLprep, which
 * holds for the ones generated here (URL-safe base64).
 */
export const scramVerifier = (password: string, salt: Buffer): string => {
    const salted = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, 'sha256');
    const storedKey = createHash('sha256').update(hmac(salted, 'Client Key')).digest();
    const serverKey = hmac(salted, 'Server Key');
    return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
};

/**
 * The verifier's salt: fixed per Database, so every render gives the same
 * verifier. A salt need not be secret, only different for each user.
 */
export const appVerifierSalt = (databaseId: Id): Buffer => createHash('sha256').update(`openupstream app verifier salt ${databaseId}`).digest().subarray(0, 16);

/** Binds the sealed password to its Database, apart from Secrets and role passwords. */
const sealedName = (databaseId: Id): string => `database-app/${databaseId}`;

/**
 * A new `app` password for the Database with this id, sealed: stored with
 * the row when it is inserted (`createDatabase`), so the operator never
 * sees the Database without it. A Database keeps the password it was
 * created with: its Services run with it.
 */
export const sealNewAppPassword = (pool: pg.Pool, kek: KeyEncryptionKey, database: { readonly id: Id; readonly projectId: Id }): Promise<Result<Buffer, SecretStoreError>> =>
    sealProjectValue(pool, kek, database.projectId, sealedName(database.id), generatePassword());

export interface AppCredentials {
    readonly databaseId: Id;
    readonly password: string;
}

/** The `app` passwords of the Project's live Databases that have one of ours, opened. */
export async function projectAppCredentials(pool: pg.Pool, kek: KeyEncryptionKey, projectId: Id): Promise<Result<readonly AppCredentials[], SecretStoreError>> {
    const { rows } = await pool.query<{ id: string; app_password: Buffer }>(
        `select id, app_password from databases
         where project_id = $1 and deleted_at is null and app_password is not null
         order by created_at, id`,
        [projectId],
    );
    const credentials: AppCredentials[] = [];
    for (const row of rows) {
        const password = await openProjectValue(pool, kek, projectId, sealedName(row.id), row.app_password);
        if (!password.ok) {
            return password;
        }
        credentials.push({ databaseId: row.id, password: password.value });
    }
    return ok(credentials);
}

const basicAuth = (projectId: Id, name: string, password: string, labels: Readonly<Record<string, string>> = {}): SecretManifest => ({
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'kubernetes.io/basic-auth',
    metadata: {
        name,
        namespace: projectNamespace(projectId),
        labels: { 'openupstream.io/project-id': projectId, 'app.kubernetes.io/managed-by': 'openupstream-control-plane', ...labels },
    },
    data: {
        username: Buffer.from(APP_USER, 'utf8').toString('base64'),
        password: Buffer.from(password, 'utf8').toString('base64'),
    },
});

/**
 * The two Secrets of a Database's `app` user: the password, under the name
 * CloudNativePG would have given its own, which Services and Jobs read; and
 * its verifier, which the Cluster reads (the reload label makes
 * CloudNativePG notice the Secret at once).
 */
export const appSecretManifests = (projectId: Id, credentials: AppCredentials): readonly SecretManifest[] => {
    const database = { id: credentials.databaseId };
    return [
        basicAuth(projectId, databaseAppSecret(database), credentials.password),
        basicAuth(projectId, databaseAppVerifierSecret(database), scramVerifier(credentials.password, appVerifierSalt(credentials.databaseId)), { 'cnpg.io/reload': 'true' }),
    ];
};
