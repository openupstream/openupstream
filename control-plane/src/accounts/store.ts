/**
 * Accounts as the public API sees them: those the caller is a Member of. A
 * signed-in madAuth user creates an Account and becomes its first Member
 * (ARCHITECTURE.md, decision 62); invitations to existing Accounts come
 * later.
 */
import type { Account } from '@openupstream/sdk';
import type pg from 'pg';

interface AccountRow {
    id: string;
    name: string;
    created_at: Date;
}

const toAccount = (row: AccountRow): Account => ({ id: row.id, name: row.name, createdAt: row.created_at.toISOString() });

export async function listAccounts(pool: pg.Pool, subject: string): Promise<Account[]> {
    const { rows } = await pool.query<AccountRow>(
        `select a.id, a.name, a.created_at from accounts a join members m on m.account_id = a.id
         where m.auth_subject = $1 order by a.created_at, a.id`,
        [subject],
    );
    return rows.map(toAccount);
}

/** The Account and its first Member, in one statement. */
export async function createAccount(pool: pg.Pool, subject: string, email: string, name: string): Promise<Account> {
    const { rows } = await pool.query<AccountRow>(
        `with account as (insert into accounts (name) values ($3) returning id, name, created_at),
         member as (insert into members (account_id, auth_subject, email) select id, $1, $2 from account)
         select id, name, created_at from account`,
        [subject, email, name],
    );
    // An insert … returning always returns its row.
    return toAccount(rows[0] as AccountRow);
}
