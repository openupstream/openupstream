/**
 * Callers' own Postgres roles (ARCHITECTURE.md, decision 126; ADR-0005).
 *
 * A caller is a Member, or one of a Member's API keys, which gets roles of
 * its own. It has at most one role per Database and access level, created
 * the first time it asks. The password is generated here and sealed with
 * the Project's data key; the control plane returns it to that caller on
 * every ask and writes it into the Secret CloudNativePG reads it from
 * (secrets/render.ts). The Databases operator adds the role to the Cluster
 * and never sees the password.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import {
    type DatabaseAccess,
    type DatabaseRoleRow,
    type Id,
    databaseRoleName,
    databaseRoleSecret,
    projectNamespace,
} from '@openupstream/sdk';
import type pg from 'pg';
import type { SecretManifest } from '../kube.js';
import { type Result, err, ok } from '../result.js';
import type { KeyEncryptionKey } from '../secrets/envelope.js';
import { type SecretStoreError, openProjectValue, sealProjectValue } from '../secrets/store.js';

/** Who asks: the madAuth user, and the API key when it is one. */
export interface Caller {
    readonly subject: string;
    readonly apiKeyId?: string | undefined;
}

export interface DatabaseRole {
    readonly id: Id;
    readonly databaseId: Id;
    readonly access: DatabaseAccess;
    /** The Postgres role's name (databaseRoleName). */
    readonly name: string;
    readonly password: string;
}

/** Binds a role's sealed password to its row, like a Secret's name; the `/` keeps it apart from Secrets. */
const sealedName = (roleId: Id): string => `database-role/${roleId}`;

/** 24 random bytes as 32 URL-safe characters: usable in a connection URL as it is. */
export const generatePassword = (): string => randomBytes(24).toString('base64url');

interface RoleRow {
    id: string;
    access: DatabaseAccess;
    password: Buffer;
}

const findRole = async (pool: pg.Pool, databaseId: Id, caller: Caller, access: DatabaseAccess): Promise<RoleRow | undefined> => {
    const { rows } = await pool.query<RoleRow>(
        `select id, access, password from database_roles
         where database_id = $1 and auth_subject = $2 and coalesce(api_key_id, '') = coalesce($3, '') and access = $4`,
        [databaseId, caller.subject, caller.apiKeyId ?? null, access],
    );
    return rows[0];
};

/**
 * The caller's role in the Database at `access`, created with a new
 * password on the first ask. Two first asks at once get the same role: the
 * one that loses the insert reads the winner's.
 */
export async function roleFor(
    pool: pg.Pool,
    kek: KeyEncryptionKey,
    database: { readonly id: Id; readonly projectId: Id },
    caller: Caller,
    access: DatabaseAccess,
): Promise<Result<DatabaseRole & { readonly created: boolean }, SecretStoreError>> {
    const existing = await findRole(pool, database.id, caller, access);
    const created = existing === undefined ? await insertRole(pool, kek, database, caller, access) : ok(undefined);
    if (!created.ok) {
        return created;
    }
    const row = existing ?? created.value ?? (await findRole(pool, database.id, caller, access));
    if (row === undefined) {
        // Only if the Database's row went between the insert and the read.
        return err({ kind: 'project-not-found', projectId: database.projectId });
    }
    const password = await openProjectValue(pool, kek, database.projectId, sealedName(row.id), row.password);
    if (!password.ok) {
        return password;
    }
    return ok({
        id: row.id,
        databaseId: database.id,
        access,
        name: databaseRoleName({ id: row.id, access }),
        password: password.value,
        created: existing === undefined && created.value !== undefined,
    });
}

/** The new row, or undefined when another ask inserted the caller's role first. */
async function insertRole(
    pool: pg.Pool,
    kek: KeyEncryptionKey,
    database: { readonly id: Id; readonly projectId: Id },
    caller: Caller,
    access: DatabaseAccess,
): Promise<Result<RoleRow | undefined, SecretStoreError>> {
    const id = randomUUID();
    const sealed = await sealProjectValue(pool, kek, database.projectId, sealedName(id), generatePassword());
    if (!sealed.ok) {
        return sealed;
    }
    const { rows } = await pool.query<RoleRow>(
        `insert into database_roles (id, database_id, auth_subject, api_key_id, access, password)
         select $1, $2, $3, $4, $5, $6 where exists (select 1 from databases where id = $2 and deleted_at is null)
         on conflict do nothing
         returning id, access, password`,
        [id, database.id, caller.subject, caller.apiKeyId ?? null, access, sealed.value],
    );
    return ok(rows[0]);
}

/** Every role of the Project's live Databases, opened, for the Secrets CloudNativePG reads. */
export async function projectRoles(pool: pg.Pool, kek: KeyEncryptionKey, projectId: Id): Promise<Result<readonly DatabaseRole[], SecretStoreError>> {
    const { rows } = await pool.query<RoleRow & { database_id: string }>(
        `select r.id, r.database_id, r.access, r.password from database_roles r
         join databases d on d.id = r.database_id
         where d.project_id = $1 and d.deleted_at is null
         order by r.created_at, r.id`,
        [projectId],
    );
    const roles: DatabaseRole[] = [];
    for (const row of rows) {
        const password = await openProjectValue(pool, kek, projectId, sealedName(row.id), row.password);
        if (!password.ok) {
            return password;
        }
        roles.push({ id: row.id, databaseId: row.database_id, access: row.access, name: databaseRoleName(row), password: password.value });
    }
    return ok(roles);
}

/** The roles of every live Database, by Database, oldest first: what the operator adds to the Clusters. */
export async function rolesByDatabase(pool: pg.Pool): Promise<ReadonlyMap<Id, readonly DatabaseRoleRow[]>> {
    const { rows } = await pool.query<{ id: string; database_id: string; access: DatabaseAccess }>(
        `select r.id, r.database_id, r.access from database_roles r
         join databases d on d.id = r.database_id
         where d.deleted_at is null
         order by r.created_at, r.id`,
    );
    const byDatabase = new Map<Id, DatabaseRoleRow[]>();
    for (const row of rows) {
        byDatabase.set(row.database_id, [...(byDatabase.get(row.database_id) ?? []), { id: row.id, access: row.access }]);
    }
    return byDatabase;
}

/**
 * The Secret CloudNativePG reads a role's password from: basic-auth with the
 * role's name, in the Project's namespace. The reload label makes
 * CloudNativePG apply a changed Secret at once.
 */
export const roleSecretManifest = (projectId: Id, role: Pick<DatabaseRole, 'id' | 'name' | 'password'>): SecretManifest => ({
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'kubernetes.io/basic-auth',
    metadata: {
        name: databaseRoleSecret(role),
        namespace: projectNamespace(projectId),
        labels: {
            'openupstream.io/project-id': projectId,
            'app.kubernetes.io/managed-by': 'openupstream-control-plane',
            'cnpg.io/reload': 'true',
        },
    },
    data: {
        username: Buffer.from(role.name, 'utf8').toString('base64'),
        password: Buffer.from(role.password, 'utf8').toString('base64'),
    },
});
