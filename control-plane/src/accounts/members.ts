/**
 * An Account's Members, their roles and their grants (ARCHITECTURE.md,
 * decisions 138, 139 and 143; docs/adr/0006-invitations-roles-account-tokens.md).
 * The schema keeps an owner in every Account (migrations, member-roles); a
 * change that would leave none is answered `last-owner` here.
 *
 * Removing a Member marks every Postgres role they and their API keys have
 * in the Account's Databases (decision 126), in the same statement: the
 * Databases operator then drops them from the Clusters (`ensure: absent`).
 * Taking a role or lowering a grant marks those their role and grants no
 * longer allow (`dropUncovered`). A user madAuth deleted is removed from
 * every Account at once (`removeUser`).
 */
import type { DatabaseAccess, Grant, Id, Member, MemberRole } from '@openupstream/sdk';
import type pg from 'pg';
import { LAST_OWNER, unlessCodes } from '../db/errors.js';
import { inTransaction } from '../db/transaction.js';
import { type Result, err, ok } from '../result.js';

interface GrantJson {
    databaseId: string;
    databaseName: string;
    projectId: string;
    projectName: string;
    access: DatabaseAccess;
    createdAt: string;
}

interface MemberRow {
    id: string;
    account_id: string;
    auth_subject: string;
    email: string;
    role: MemberRole | null;
    grants: GrantJson[];
    created_at: Date;
}

const toGrant = (grant: GrantJson): Grant => ({ ...grant, createdAt: new Date(grant.createdAt).toISOString() });

const toMember = (row: MemberRow): Member => ({
    id: row.id,
    accountId: row.account_id,
    authSubject: row.auth_subject,
    email: row.email,
    role: row.role,
    grants: row.grants.map(toGrant),
    createdAt: row.created_at.toISOString(),
});

/** A grant's JSON from `g` joined with its Database `d` and Project `p`. */
const GRANT_JSON = `jsonb_build_object('databaseId', d.id, 'databaseName', d.name, 'projectId', p.id, 'projectName', p.name,
                                       'access', g.access, 'createdAt', g.created_at)`;
/** The grants on live Databases of the Member `m`. */
const GRANTS = `coalesce((
    select jsonb_agg(${GRANT_JSON} order by g.created_at, d.id)
    from grants g join databases d on d.id = g.database_id and d.deleted_at is null
    join projects p on p.id = d.project_id and p.deleted_at is null
    where g.member_id = m.id
), '[]')`;
const SELECT = `select m.id, m.account_id, m.auth_subject, m.email, m.role, m.created_at, ${GRANTS} as grants from members m`;

export type MemberError = { readonly kind: 'not-found' } | { readonly kind: 'last-owner' };
export type GrantError = { readonly kind: 'member-not-found' } | { readonly kind: 'database-not-found' };

/** The Account's Members, oldest first. */
export async function listMembers(pool: pg.Pool | pg.PoolClient, accountId: Id): Promise<Member[]> {
    const { rows } = await pool.query<MemberRow>(`${SELECT} where m.account_id = $1 order by m.created_at, m.id`, [accountId]);
    return rows.map(toMember);
}

/** The caller's own Member row in the Account; undefined when they are none. */
export async function memberOf(pool: pg.Pool, accountId: Id, subject: string): Promise<Member | undefined> {
    const { rows } = await pool.query<MemberRow>(`${SELECT} where m.account_id = $1 and m.auth_subject = $2`, [accountId, subject]);
    const row = rows[0];
    return row === undefined ? undefined : toMember(row);
}

const memberById = async (client: pg.PoolClient, accountId: Id, memberId: Id): Promise<Member | undefined> => {
    const { rows } = await client.query<MemberRow>(`${SELECT} where m.account_id = $1 and m.id = $2`, [accountId, memberId]);
    const row = rows[0];
    return row === undefined ? undefined : toMember(row);
};

/** A Database the caller may use through a grant, while their Member in its Account has no role. */
export interface CallerGrant {
    readonly accountId: Id;
    readonly projectId: Id;
    readonly databaseId: Id;
    readonly access: DatabaseAccess;
}

/** The madAuth user's grants that count: on live Databases, in Accounts where their Member has no role. */
export async function grantsOf(pool: pg.Pool, subject: string): Promise<CallerGrant[]> {
    const { rows } = await pool.query<{ account_id: string; project_id: string; database_id: string; access: DatabaseAccess }>(
        `select m.account_id, d.project_id, d.id as database_id, g.access
         from members m join grants g on g.member_id = m.id
         join databases d on d.id = g.database_id and d.deleted_at is null
         join projects p on p.id = d.project_id and p.deleted_at is null
         where m.auth_subject = $1 and m.role is null
         order by m.account_id, d.project_id, d.id`,
        [subject],
    );
    return rows.map((row) => ({ accountId: row.account_id, projectId: row.project_id, databaseId: row.database_id, access: row.access }));
}

/**
 * Marks the Postgres roles of the user, and of their API keys, in the
 * Account's Databases that their Member's role and grants no longer allow:
 * all of them without a Member, none with a role, and otherwise those on a
 * Database without a grant or above its level. Run under the caller's lock
 * after every change of a role or grant.
 */
async function dropUncovered(client: pg.PoolClient, accountId: Id, subject: string): Promise<DroppedRole[]> {
    const { rows } = await client.query<{ dropped: DroppedRole[] }>(
        `with member as (select id, role from members where account_id = $1 and auth_subject = $2),
         dropped as (
             update database_roles r set dropped_at = now()
             from databases d join projects p on p.id = d.project_id
             where r.database_id = d.id and p.account_id = $1 and r.auth_subject = $2 and r.dropped_at is null
               and not exists (select 1 from member where role is not null)
               and not exists (
                   select 1 from grants g join member on member.id = g.member_id
                   where g.database_id = r.database_id and database_access_rank(g.access) >= database_access_rank(r.access)
               )
             returning r.id, r.access, d.project_id
         )
         select coalesce((select jsonb_agg(jsonb_build_object('id', id, 'projectId', project_id, 'access', access)) from dropped), '[]') as dropped`,
        [accountId, subject],
    );
    return rows[0]?.dropped ?? [];
}

/** Locks the Member's place in the Account and returns their subject; undefined when there is no such Member. */
const lockMember = async (client: pg.PoolClient, accountId: Id, memberId: Id): Promise<string | undefined> => {
    const { rows } = await client.query<{ auth_subject: string }>('select auth_subject from members where account_id = $1 and id = $2', [
        accountId,
        memberId,
    ]);
    const subject = rows[0]?.auth_subject;
    if (subject !== undefined) {
        await client.query(`select ${lockCaller('$1', '$2')}`, [accountId, subject]);
    }
    return subject;
};

/** A change to a Member and the Postgres roles it took from them. */
export interface MemberChange<T> {
    readonly value: T;
    readonly dropped: readonly DroppedRole[];
}

/**
 * Gives the Member another role, or none. Between owner and developer no
 * database access level is lost (decision 140); without a role, the
 * Postgres roles their grants do not allow are dropped.
 */
export async function changeRole(
    pool: pg.Pool,
    accountId: Id,
    memberId: Id,
    role: MemberRole | null,
): Promise<Result<MemberChange<Member>, MemberError>> {
    return inTransaction(
        pool,
        async (client): Promise<Result<MemberChange<Member>, MemberError>> => {
            const subject = await lockMember(client, accountId, memberId);
            if (subject === undefined) {
                return err({ kind: 'not-found' });
            }
            const updated = await unlessCodes(client.query('update members set role = $3 where account_id = $1 and id = $2', [accountId, memberId, role]), {
                [LAST_OWNER]: { kind: 'last-owner' } as const,
            });
            if (!updated.ok) {
                return updated;
            }
            const dropped = await dropUncovered(client, accountId, subject);
            const member = await memberById(client, accountId, memberId);
            return member === undefined ? err({ kind: 'not-found' }) : ok({ value: member, dropped });
        },
        (result) => result.ok,
    );
}

/**
 * Gives the Member a grant on a live Database of the Account at `access`,
 * or changes its level; a lower one drops their Postgres roles above it
 * while they have no role.
 */
export async function setGrant(
    pool: pg.Pool,
    accountId: Id,
    memberId: Id,
    databaseId: Id,
    access: DatabaseAccess,
): Promise<Result<MemberChange<Grant> & { readonly created: boolean }, GrantError>> {
    return inTransaction(
        pool,
        async (client): Promise<Result<MemberChange<Grant> & { readonly created: boolean }, GrantError>> => {
            const subject = await lockMember(client, accountId, memberId);
            if (subject === undefined) {
                return err({ kind: 'member-not-found' });
            }
            const { rows } = await client.query<{ grant: GrantJson; created: boolean }>(
                `with g as (
                     insert into grants (member_id, database_id, access)
                     select $2, d.id, $4 from databases d join projects p on p.id = d.project_id
                     where d.id = $3 and p.account_id = $1 and d.deleted_at is null and p.deleted_at is null
                     on conflict (member_id, database_id) do update set access = excluded.access
                     returning access, created_at, database_id, (xmax = 0) as created
                 )
                 select ${GRANT_JSON} as grant, g.created
                 from g join databases d on d.id = g.database_id join projects p on p.id = d.project_id`,
                [accountId, memberId, databaseId, access],
            );
            const row = rows[0];
            if (row === undefined) {
                return err({ kind: 'database-not-found' });
            }
            return ok({ value: toGrant(row.grant), created: row.created, dropped: await dropUncovered(client, accountId, subject) });
        },
        (result) => result.ok,
    );
}

/** Takes the Member's grant on the Database away, and with it their Postgres roles there while they have no role. */
export async function removeGrant(pool: pg.Pool, accountId: Id, memberId: Id, databaseId: Id): Promise<Result<readonly DroppedRole[], GrantError>> {
    return inTransaction(
        pool,
        async (client): Promise<Result<readonly DroppedRole[], GrantError>> => {
            const subject = await lockMember(client, accountId, memberId);
            if (subject === undefined) {
                return err({ kind: 'member-not-found' });
            }
            const deleted = await client.query('delete from grants where member_id = $1 and database_id = $2', [memberId, databaseId]);
            return deleted.rowCount === 0 ? err({ kind: 'database-not-found' }) : ok(await dropUncovered(client, accountId, subject));
        },
        (result) => result.ok,
    );
}

/**
 * A Postgres role taken from a removed Member: its Secret in the Project's
 * namespace goes too, and an `owner` role's open session needs its tunnel
 * restarted, since it acts as `app` and outlives the role.
 */
export interface DroppedRole {
    readonly id: Id;
    readonly projectId: Id;
    readonly access: DatabaseAccess;
}

/**
 * The SQL that locks a user's place in an Account for the rest of the
 * transaction, from SQL expressions for the Account's id and the madAuth
 * subject: taken by a removal and by the creation of a Postgres role
 * (databases/roles.ts), so a role is never created for a Member whose
 * removal is under way and left unmarked.
 */
export const lockCaller = (accountId: string, subject: string): string =>
    `pg_advisory_xact_lock(hashtextextended('member:' || ${accountId}::text || '/' || ${subject}::text, 0))`;

/**
 * Removes the Member and marks their Postgres roles, and those of their API
 * keys, in every Database of the Account, in one statement: when the schema
 * refuses the delete (the last owner), no role is marked either. The lock
 * comes first, in a statement of its own, so the removal sees every role
 * created before it.
 */
export async function removeMember(pool: pg.Pool, accountId: Id, memberId: Id): Promise<Result<readonly DroppedRole[], MemberError>> {
    return inTransaction(
        pool,
        async (client) => {
            const subject = await lockMember(client, accountId, memberId);
            return subject === undefined ? err({ kind: 'not-found' } as const) : removeLocked(client, accountId, memberId);
        },
        (result) => result.ok,
    );
}

async function removeLocked(client: pg.PoolClient, accountId: Id, memberId: Id): Promise<Result<readonly DroppedRole[], MemberError>> {
    const removed = await unlessCodes(
        client.query<{ removed: boolean; dropped: DroppedRole[] }>(
            `with member as (
                 delete from members where account_id = $1 and id = $2 returning auth_subject
             ),
             dropped as (
                 update database_roles r set dropped_at = now()
                 from databases d join projects p on p.id = d.project_id
                 where r.database_id = d.id and p.account_id = $1 and r.dropped_at is null
                   and r.auth_subject in (select auth_subject from member)
                 returning r.id, r.access, d.project_id
             )
             select exists (select 1 from member) as removed,
                    coalesce((select jsonb_agg(jsonb_build_object('id', id, 'projectId', project_id, 'access', access)) from dropped), '[]') as dropped`,
            [accountId, memberId],
        ),
        { [LAST_OWNER]: { kind: 'last-owner' } as const },
    );
    if (!removed.ok) {
        return removed;
    }
    const row = removed.value.rows[0];
    return row?.removed === true ? ok(row.dropped) : err({ kind: 'not-found' });
}

/** What removing a deleted user did: their dropped roles, and the Accounts left without an owner. */
export interface RemovedUser {
    readonly accounts: number;
    readonly dropped: readonly DroppedRole[];
    readonly ownerless: readonly Id[];
}

/**
 * Removes a user madAuth deleted (its `user.deleted`) from every Account and
 * marks all their Postgres roles and those of their API keys. madAuth cannot
 * be kept from deleting a user, so this alone may leave an Account without
 * an owner: the schema lets it for this transaction only, and the Accounts
 * it happened to are returned for the log. Running it again finds nothing.
 */
export async function removeUser(pool: pg.Pool, subject: string): Promise<RemovedUser> {
    return inTransaction(
        pool,
        async (client) => {
            await client.query("select set_config('openupstream.owner_may_go', 'on', true)");
            // The same lock as a single removal, per Account, in a fixed order.
            const { rows: accounts } = await client.query<{ account_id: string }>(
                'select account_id from members where auth_subject = $1 order by account_id',
                [subject],
            );
            for (const { account_id } of accounts) {
                await client.query(`select ${lockCaller('$1', '$2')}`, [account_id, subject]);
            }
            const { rows } = await client.query<RemovedUser>(
                `with removed as (
                     delete from members where auth_subject = $1 returning account_id, role
                 ),
                 dropped as (
                     update database_roles r set dropped_at = now()
                     from databases d
                     where r.database_id = d.id and r.auth_subject = $1 and r.dropped_at is null
                     returning r.id, r.access, d.project_id
                 )
                 select (select count(*)::int from removed) as accounts,
                        coalesce((select jsonb_agg(jsonb_build_object('id', id, 'projectId', project_id, 'access', access)) from dropped), '[]') as dropped,
                        coalesce((select jsonb_agg(account_id) from removed
                                  where role = 'owner' and not exists (
                                      select 1 from members m
                                      where m.account_id = removed.account_id and m.role = 'owner' and m.auth_subject <> $1
                                  )), '[]') as ownerless`,
                [subject],
            );
            return rows[0] ?? { accounts: 0, dropped: [], ownerless: [] };
        },
        () => true,
    );
}
