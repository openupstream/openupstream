/**
 * Accounts as the public API sees them: those the caller is a Member of. A
 * signed-in madAuth user creates an Account and becomes its first Member
 * (ARCHITECTURE.md, decision 62); invitations to existing Accounts come
 * later.
 *
 * An Account's Holds stop it from creating Resources (decision 78). The
 * billing service places and lifts them through the internal API; new
 * Accounts start with the Holds the control plane is configured with.
 */
import type { Account, AccountRecord } from '@openupstream/sdk';
import type pg from 'pg';

interface AccountRow {
    id: string;
    name: string;
    created_at: Date;
    holds: string[];
}

const toAccount = (row: AccountRow): Account => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
    holds: row.holds,
});

/** An Account's Hold reasons, sorted; a correlated subquery on `a`. */
const HOLDS = `array(select h.reason from account_holds h where h.account_id = a.id order by h.reason) as holds`;

export async function listAccounts(pool: pg.Pool, subject: string): Promise<Account[]> {
    const { rows } = await pool.query<AccountRow>(
        `select a.id, a.name, a.created_at, ${HOLDS} from accounts a join members m on m.account_id = a.id
         where m.auth_subject = $1 order by a.created_at, a.id`,
        [subject],
    );
    return rows.map(toAccount);
}

/** The Account, its first Member and its first Holds, in one statement. */
export async function createAccount(
    pool: pg.Pool,
    subject: string,
    email: string,
    name: string,
    holds: readonly string[],
): Promise<Account> {
    const { rows } = await pool.query<AccountRow>(
        `with account as (insert into accounts (name) values ($3) returning id, name, created_at),
         member as (insert into members (account_id, auth_subject, email) select id, $1, $2 from account),
         hold as (insert into account_holds (account_id, reason) select id, unnest($4::text[]) from account)
         select id, name, created_at, array(select unnest($4::text[]) order by 1) as holds from account`,
        [subject, email, name, [...new Set(holds)]],
    );
    // An insert … returning always returns its row.
    return toAccount(rows[0] as AccountRow);
}

/** The reasons the Account may not create Resources now; empty when it may. */
export async function holdsOf(pool: pg.Pool, accountId: string): Promise<string[]> {
    const { rows } = await pool.query<{ reason: string }>(
        'select reason from account_holds where account_id = $1 order by reason',
        [accountId],
    );
    return rows.map((row) => row.reason);
}

/** The Account with its Holds and Members, for the billing service; undefined if there is none. */
export async function getAccountRecord(pool: pg.Pool, id: string): Promise<AccountRecord | undefined> {
    const { rows } = await pool.query<AccountRow & { members: { authSubject: string; email: string }[] }>(
        `select a.id, a.name, a.created_at, ${HOLDS},
                coalesce((select jsonb_agg(jsonb_build_object('authSubject', m.auth_subject, 'email', m.email) order by m.created_at, m.id)
                          from members m where m.account_id = a.id), '[]') as members
         from accounts a where a.id = $1`,
        [id],
    );
    const row = rows[0];
    return row === undefined ? undefined : { ...toAccount(row), members: row.members };
}

/** Places the Hold; false if there is no such Account. Placing it again changes nothing. */
export async function placeHold(pool: pg.Pool, accountId: string, reason: string): Promise<boolean> {
    const { rowCount } = await pool.query(
        `with account as (select id from accounts where id = $1),
         hold as (insert into account_holds (account_id, reason) select id, $2 from account on conflict do nothing)
         select 1 from account`,
        [accountId, reason],
    );
    return rowCount === 1;
}

/** Lifts the Hold; false if there is no such Account. Lifting one that is not there changes nothing. */
export async function liftHold(pool: pg.Pool, accountId: string, reason: string): Promise<boolean> {
    const { rowCount } = await pool.query(
        `with account as (select id from accounts where id = $1),
         hold as (delete from account_holds h using account where h.account_id = account.id and h.reason = $2)
         select 1 from account`,
        [accountId, reason],
    );
    return rowCount === 1;
}
