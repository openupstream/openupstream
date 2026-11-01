/**
 * The waitlist's addresses (ARCHITECTURE.md, decision 86; the table is in
 * migrations/1761919200000_waitlist.sql). Every e-mail carries a fresh
 * random token; only its SHA-256 is stored. Every token of an address
 * confirms or removes it (a pending one's for CONFIRM_WITHIN).
 */
import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

/** How long a confirmation link works; an unconfirmed address is deleted after it. */
export const CONFIRM_WITHIN = '48 hours';

/** At most one e-mail per address in this time, so nobody can use the form to flood a mailbox. */
export const MAIL_AT_MOST_EVERY = '1 hour';

/** A token for an e-mail's links, and the hash that is stored. */
export const newToken = (): { token: string; hash: Buffer } => {
    const token = randomBytes(32).toString('base64url');
    return { token, hash: hashToken(token) };
};

export const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

/** The tokens an address keeps; older ones are dropped, so repeated requests cannot grow the table. */
export const TOKENS_PER_ADDRESS = 20;

/**
 * Records a request for `email` with the token of the e-mail about to be
 * sent: a new address is pending, a pending one gets the new consent, a
 * confirmed one keeps its consent. The token is added to the address's
 * earlier ones, which stay valid. The answer is which e-mail to send:
 * undefined when the address had one within MAIL_AT_MOST_EVERY, so none is
 * sent and no token is added.
 */
export async function requestEntry(
    pool: pg.Pool,
    email: string,
    tokenHash: Buffer,
    consent: string,
): Promise<'confirm' | 'already-confirmed' | undefined> {
    const { rows } = await pool.query<{ confirmed: boolean }>(
        `with entry as (
             insert into waitlist (email, consent) values ($1, $3)
             on conflict (email) do update set
                 mailed_at = now(),
                 consent = case when waitlist.confirmed_at is null then excluded.consent else waitlist.consent end,
                 requested_at = case when waitlist.confirmed_at is null then now() else waitlist.requested_at end
             where waitlist.mailed_at < now() - $4::interval
             returning email, confirmed_at is not null as confirmed
         ), token as (
             insert into waitlist_tokens (token_hash, email) select $2, email from entry
         )
         select confirmed from entry`,
        [email, tokenHash, consent, MAIL_AT_MOST_EVERY],
    );
    const row = rows[0];
    if (row === undefined) {
        return undefined;
    }
    await pool.query(
        `delete from waitlist_tokens where email = $1 and token_hash not in (
             select token_hash from waitlist_tokens where email = $1 order by created_at desc limit $2)`,
        [email, TOKENS_PER_ADDRESS],
    );
    return row.confirmed ? 'already-confirmed' : 'confirm';
}

/**
 * The e-mail for this token could not be sent: the token goes, and the
 * address counts as mailed when its last e-mail that did go out was sent,
 * so it may have another one at once and its earlier links keep working.
 * A new address that never got one is deleted by the next cleanup pass.
 */
export async function mailFailed(pool: pg.Pool, tokenHash: Buffer): Promise<void> {
    await pool.query(
        `with gone as (delete from waitlist_tokens where token_hash = $1 returning email)
         update waitlist w set mailed_at = coalesce(
             (select max(t.created_at) from waitlist_tokens t where t.email = w.email and t.token_hash <> $1),
             '-infinity')
         where w.email in (select email from gone)`,
        [tokenHash],
    );
}

export type EntryState = 'pending' | 'confirmed';

/** A token is valid for a confirmed address, and for a pending one for CONFIRM_WITHIN. */
const VALID = `t.token_hash = $1 and t.email = w.email and (w.confirmed_at is not null or t.created_at > now() - $2::interval)`;

/** What a link's token stands for; undefined for an unknown or expired one. */
export async function entryState(pool: pg.Pool, tokenHash: Buffer): Promise<EntryState | undefined> {
    const { rows } = await pool.query<{ confirmed: boolean }>(
        `select w.confirmed_at is not null as confirmed from waitlist w, waitlist_tokens t where ${VALID}`,
        [tokenHash, CONFIRM_WITHIN],
    );
    const row = rows[0];
    return row === undefined ? undefined : row.confirmed ? 'confirmed' : 'pending';
}

/** Confirms the address of this token; false for an unknown or expired one. Confirming twice is fine. */
export async function confirmEntry(pool: pg.Pool, tokenHash: Buffer): Promise<boolean> {
    const { rowCount } = await pool.query(
        `update waitlist w set confirmed_at = coalesce(w.confirmed_at, now()) from waitlist_tokens t where ${VALID}`,
        [tokenHash, CONFIRM_WITHIN],
    );
    return rowCount === 1;
}

/** Deletes the address of this token with all its tokens, pending or confirmed; false for an unknown one. */
export async function removeEntry(pool: pg.Pool, tokenHash: Buffer): Promise<boolean> {
    const { rowCount } = await pool.query(
        'delete from waitlist where email = (select email from waitlist_tokens where token_hash = $1)',
        [tokenHash],
    );
    return rowCount === 1;
}

/** Deletes the addresses nobody confirmed within CONFIRM_WITHIN of their last e-mail; returns how many. */
export async function purgeUnconfirmed(pool: pg.Pool): Promise<number> {
    const { rowCount } = await pool.query(
        `delete from waitlist where confirmed_at is null and mailed_at < now() - $1::interval`,
        [CONFIRM_WITHIN],
    );
    return rowCount ?? 0;
}
