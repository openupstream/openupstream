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
    DATABASE_TUNNEL_PODS,
    type DatabaseAccess,
    type DatabaseRoleRow,
    type Id,
    databaseRoleName,
    databaseRoleSecret,
    projectNamespace,
} from '@openupstream/sdk';
import type pg from 'pg';
import { type DroppedRole, lockCaller } from '../accounts/members.js';
import { inTransaction } from '../db/transaction.js';
import type { ControlPlaneKube, SecretManifest } from '../kube.js';
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
         where database_id = $1 and auth_subject = $2 and coalesce(api_key_id, '') = coalesce($3, '') and access = $4
           and dropped_at is null`,
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
    // Under the caller's lock, and only while their role or a grant at this level or above still
    // allows it: a removal, a lost role or a lower grant that runs meanwhile either sees this row and
    // marks it, or came first and nothing is inserted.
    // An API key's own lock and the revoked keys do the same for a revocation (revokeApiKey).
    const inserted = await inTransaction(
        pool,
        async (client) => {
            await client.query(
                `select ${lockCaller('p.account_id', '$1')} from databases d join projects p on p.id = d.project_id where d.id = $2`,
                [caller.subject, database.id],
            );
            if (caller.apiKeyId !== undefined) {
                await client.query(`select ${lockApiKey('$1')}`, [caller.apiKeyId]);
            }
            return client.query<RoleRow>(
                `insert into database_roles (id, database_id, auth_subject, api_key_id, access, password)
                 select $1, $2, $3, $4, $5, $6
                 where exists (
                     select 1 from databases d join projects p on p.id = d.project_id
                     join members m on m.account_id = p.account_id and m.auth_subject = $3
                     where d.id = $2 and d.deleted_at is null
                       and (m.role is not null or exists (
                           select 1 from grants g
                           where g.member_id = m.id and g.database_id = d.id
                             and database_access_rank(g.access) >= database_access_rank($5)
                       ))
                 )
                 and not exists (select 1 from revoked_api_keys where api_key_id = $4)
                 on conflict do nothing
                 returning id, access, password`,
                [id, database.id, caller.subject, caller.apiKeyId ?? null, access, sealed.value],
            );
        },
        () => true,
    );
    return ok(inserted.rows[0]);
}

/**
 * The SQL that locks an API key for the rest of the transaction, from an SQL
 * expression for its id: taken by its revocation and, after the Member's
 * lock, by the creation of one of its roles.
 */
const lockApiKey = (apiKeyId: string): string => `pg_advisory_xact_lock(hashtextextended('api-key:' || ${apiKeyId}::text, 0))`;

/**
 * Records a key madAuth revoked (its `user.api_key_revoked`) and marks its
 * Postgres roles in every Database, so the Databases operator drops them;
 * until now they stayed until their Database went (ADR-0005). The key may
 * still be accepted for a minute (decision 64), but no new role is created
 * for it. Running it again marks nothing.
 */
export async function revokeApiKey(pool: pg.Pool, subject: string, apiKeyId: string): Promise<readonly DroppedRole[]> {
    return inTransaction(
        pool,
        async (client) => {
            await client.query(`select ${lockApiKey('$1')}`, [apiKeyId]);
            const { rows } = await client.query<{ dropped: DroppedRole[] }>(
                `with revoked as (
                     insert into revoked_api_keys (api_key_id, auth_subject) values ($1, $2) on conflict do nothing
                 ),
                 dropped as (
                     update database_roles r set dropped_at = now()
                     from databases d
                     where r.database_id = d.id and r.api_key_id = $1 and r.auth_subject = $2 and r.dropped_at is null
                     returning r.id, r.access, d.project_id
                 )
                 select coalesce((select jsonb_agg(jsonb_build_object('id', id, 'projectId', project_id, 'access', access)) from dropped), '[]') as dropped`,
                [apiKeyId, subject],
            );
            return rows[0]?.dropped ?? [];
        },
        () => true,
    );
}

/**
 * After roles were marked: their Secrets go at once (the secrets pass
 * deletes them again for DROPPED_SECRET_RETRY), and in each Project where
 * an `owner` role went the open sessions are ended (endDroppedOwnerSessions;
 * also retried by the secrets pass). Failures are logged, not returned:
 * the marks are what counts, and the retries follow them.
 */
export async function forgetDroppedRoles(
    pool: pg.Pool,
    kube: Pick<ControlPlaneKube, 'listPods' | 'remove'>,
    dropped: readonly DroppedRole[],
    log: (entry: Record<string, unknown>) => void,
): Promise<void> {
    for (const role of dropped) {
        const deleted = await kube.remove({ apiVersion: 'v1', kind: 'Secret', namespace: projectNamespace(role.projectId), name: databaseRoleSecret(role) });
        if (!deleted.ok) {
            log({ msg: 'cannot delete a dropped database role Secret; the secrets pass will', role: role.id, error: deleted.error });
        }
    }
    for (const projectId of new Set(dropped.filter((role) => role.access === 'owner').map((role) => role.projectId))) {
        const ended = await endDroppedOwnerSessions(pool, kube, projectId);
        if (!ended.ok) {
            log({ msg: 'cannot end the database tunnels after dropping roles; the secrets pass will', projectId, error: ended.error });
        }
    }
}

/** Every role of the Project's live Databases that is not dropped, opened, for the Secrets CloudNativePG reads. */
export async function projectRoles(pool: pg.Pool, kek: KeyEncryptionKey, projectId: Id): Promise<Result<readonly DatabaseRole[], SecretStoreError>> {
    const { rows } = await pool.query<RoleRow & { database_id: string }>(
        `select r.id, r.database_id, r.access, r.password from database_roles r
         join databases d on d.id = r.database_id
         where d.project_id = $1 and d.deleted_at is null and r.dropped_at is null
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

/** How long the secrets pass keeps deleting a dropped role's Secret, in case the delete at its removal failed or a pass wrote it back. */
export const DROPPED_SECRET_RETRY = '1 hour';

/** The roles of the Project's Databases dropped within DROPPED_SECRET_RETRY, whose Secrets go. */
export async function recentlyDroppedRoles(pool: pg.Pool, projectId: Id): Promise<readonly { readonly id: Id }[]> {
    const { rows } = await pool.query<{ id: string }>(
        `select r.id from database_roles r join databases d on d.id = r.database_id
         where d.project_id = $1 and r.dropped_at > now() - $2::interval`,
        [projectId, DROPPED_SECRET_RETRY],
    );
    return rows;
}

/**
 * Ends the open sessions of the Project's `owner` roles dropped within
 * DROPPED_SECRET_RETRY and not ended yet: such a session acts as `app` and
 * outlives its role (dev cluster, 2026-11-17), so the Project's tunnel
 * pods are deleted, which closes every tunnel there; the Deployment starts
 * a new pod and other callers' tools reconnect. Recorded once done, so a
 * failed attempt is made again by the next secrets pass. The number of
 * roles whose sessions it ended.
 */
export async function endDroppedOwnerSessions(
    pool: pg.Pool,
    kube: Pick<ControlPlaneKube, 'listPods' | 'remove'>,
    projectId: Id,
): Promise<Result<number, string>> {
    const { rows } = await pool.query<{ id: string }>(
        `select r.id from database_roles r join databases d on d.id = r.database_id
         where d.project_id = $1 and r.access = 'owner' and r.sessions_ended_at is null and r.dropped_at > now() - $2::interval`,
        [projectId, DROPPED_SECRET_RETRY],
    );
    if (rows.length === 0) {
        return ok(0);
    }
    const namespace = projectNamespace(projectId);
    const pods = await kube.listPods(namespace, DATABASE_TUNNEL_PODS);
    if (!pods.ok) {
        return pods;
    }
    for (const pod of pods.value) {
        const deleted = await kube.remove({ apiVersion: 'v1', kind: 'Pod', namespace, name: pod.name });
        if (!deleted.ok) {
            return deleted;
        }
    }
    await pool.query('update database_roles set sessions_ended_at = now() where id = any($1)', [rows.map((row) => row.id)]);
    return ok(rows.length);
}

/**
 * The roles of every live Database, by Database, oldest first: what the
 * operator adds to the Clusters. Dropped ones too, for as long as the
 * Database lives, so CloudNativePG drops them whenever it can (decision 143).
 */
export async function rolesByDatabase(pool: pg.Pool): Promise<ReadonlyMap<Id, readonly DatabaseRoleRow[]>> {
    const { rows } = await pool.query<{ id: string; database_id: string; access: DatabaseAccess; dropped: boolean }>(
        `select r.id, r.database_id, r.access, r.dropped_at is not null as dropped from database_roles r
         join databases d on d.id = r.database_id
         where d.deleted_at is null
         order by r.created_at, r.id`,
    );
    const byDatabase = new Map<Id, DatabaseRoleRow[]>();
    for (const row of rows) {
        const role: DatabaseRoleRow = row.dropped ? { id: row.id, access: row.access, dropped: true } : { id: row.id, access: row.access };
        byDatabase.set(row.database_id, [...(byDatabase.get(row.database_id) ?? []), role]);
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
