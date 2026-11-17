/**
 * An Account's Members and their roles (ARCHITECTURE.md, decisions 137 and
 * 142; docs/adr/0006-invitations-roles-account-tokens.md). The schema keeps
 * an owner in every Account (migrations, member-roles); a change that would
 * leave none is answered `last-owner` here.
 *
 * Removing a Member marks every Postgres role they and their API keys have
 * in the Account's Databases (decision 126), in the same statement: the
 * Databases operator then drops them from the Clusters (`ensure: absent`).
 */
import type { Id, Member, MemberRole } from '@openupstream/sdk';
import type pg from 'pg';
import { LAST_OWNER, unlessCodes } from '../db/errors.js';
import { type Result, err, ok } from '../result.js';

interface MemberRow {
    id: string;
    account_id: string;
    auth_subject: string;
    email: string;
    role: MemberRole | null;
    created_at: Date;
}

const toMember = (row: MemberRow): Member => ({
    id: row.id,
    accountId: row.account_id,
    authSubject: row.auth_subject,
    email: row.email,
    role: row.role,
    createdAt: row.created_at.toISOString(),
});

const COLUMNS = 'id, account_id, auth_subject, email, role, created_at';

export type MemberError = { readonly kind: 'not-found' } | { readonly kind: 'last-owner' };

/** The Account's Members, oldest first. */
export async function listMembers(pool: pg.Pool, accountId: Id): Promise<Member[]> {
    const { rows } = await pool.query<MemberRow>(`select ${COLUMNS} from members where account_id = $1 order by created_at, id`, [
        accountId,
    ]);
    return rows.map(toMember);
}

/** The caller's own Member row in the Account; undefined when they are none. */
export async function memberOf(pool: pg.Pool, accountId: Id, subject: string): Promise<Member | undefined> {
    const { rows } = await pool.query<MemberRow>(`select ${COLUMNS} from members where account_id = $1 and auth_subject = $2`, [
        accountId,
        subject,
    ]);
    const row = rows[0];
    return row === undefined ? undefined : toMember(row);
}

/**
 * Gives the Member another role. Between owner and developer no database
 * access level is lost (decision 139), so no Postgres role is dropped.
 */
export async function changeRole(pool: pg.Pool, accountId: Id, memberId: Id, role: MemberRole): Promise<Result<Member, MemberError>> {
    const updated = await unlessCodes(
        pool.query<MemberRow>(`update members set role = $3 where account_id = $1 and id = $2 returning ${COLUMNS}`, [accountId, memberId, role]),
        { [LAST_OWNER]: { kind: 'last-owner' } as const },
    );
    if (!updated.ok) {
        return updated;
    }
    const row = updated.value.rows[0];
    return row === undefined ? err({ kind: 'not-found' }) : ok(toMember(row));
}

/** A Postgres role taken from a removed Member: its Secret in the Project's namespace goes too. */
export interface DroppedRole {
    readonly id: Id;
    readonly projectId: Id;
}

/**
 * Removes the Member and marks their Postgres roles, and those of their API
 * keys, in every Database of the Account, in one statement: when the schema
 * refuses the delete (the last owner), no role is marked either.
 */
export async function removeMember(pool: pg.Pool, accountId: Id, memberId: Id): Promise<Result<readonly DroppedRole[], MemberError>> {
    const removed = await unlessCodes(
        pool.query<{ removed: boolean; dropped: DroppedRole[] }>(
            `with member as (
                 delete from members where account_id = $1 and id = $2 returning auth_subject
             ),
             dropped as (
                 update database_roles r set dropped_at = now()
                 from databases d join projects p on p.id = d.project_id
                 where r.database_id = d.id and p.account_id = $1 and r.dropped_at is null
                   and r.auth_subject in (select auth_subject from member)
                 returning r.id, d.project_id
             )
             select exists (select 1 from member) as removed,
                    coalesce((select jsonb_agg(jsonb_build_object('id', id, 'projectId', project_id)) from dropped), '[]') as dropped`,
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
