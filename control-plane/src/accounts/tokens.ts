/**
 * Account tokens (ARCHITECTURE.md, decision 144;
 * docs/adr/0006-invitations-roles-account-tokens.md): named secrets that
 * belong to an Account, for CI, BI tools and scripts outside the platform,
 * with the developer role or grants, never owner.
 *
 * The secret is `oup_tok_` and 32 random bytes; only its SHA-256 is kept
 * (enough for a random secret of that length: there is nothing to guess
 * from), and every request looks it up, so a revoked token stops at once.
 * A roll adds a new secret and keeps the old one for 24 hours. Revoking
 * marks the token rather than deleting it: its Postgres roles keep
 * pointing at it while the Databases operator drops them, as for a
 * removed Member (decision 143).
 *
 * Every change to a token's rights takes the token's lock, as does the
 * creation of one of its Postgres roles (databases/roles.ts), so a role is
 * never created for a token whose revocation, lost role or lower grant is
 * under way and left unmarked.
 */
import { createHash, randomBytes } from 'node:crypto';
import { ACCOUNT_TOKEN_PREFIX, type AccountToken, type AccountTokenRole, type AccountTokenWithSecret, type DatabaseAccess, type Grant, type Id } from '@openupstream/sdk';
import type pg from 'pg';
import { UNIQUE_VIOLATION, unlessCodes } from '../db/errors.js';
import { inTransaction } from '../db/transaction.js';
import { type Result, err, ok } from '../result.js';
import { type CallerGrant, type DroppedRole, GRANT_JSON, type GrantJson, toGrant } from './members.js';

/** How long a rolled-away secret keeps working, so CI can be switched over (decision 144). */
export const ROLL_OVERLAP = '24 hours';

/** last_used_at is written at most this often per token, not on every request. */
const LAST_USE_PRECISION = '1 minute';

/** A new secret: the prefix and 32 random bytes, URL-safe. */
export const generateTokenSecret = (): string => `${ACCOUNT_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;

const hashOf = (secret: string): Buffer => createHash('sha256').update(secret).digest();

/**
 * The SQL that locks an Account token for the rest of the transaction, from
 * an SQL expression for its id.
 */
export const lockAccountToken = (tokenId: string): string => `pg_advisory_xact_lock(hashtextextended('account-token:' || ${tokenId}::text, 0))`;

interface TokenRow {
    id: string;
    account_id: string;
    name: string;
    role: AccountTokenRole | null;
    grants: GrantJson[];
    expires_at: Date;
    last_used_at: Date | null;
    created_at: Date;
}

const toToken = (row: TokenRow): AccountToken => ({
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    role: row.role,
    grants: row.grants.map(toGrant),
    expiresAt: row.expires_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
});

/** The grants on live Databases of the token `t`. */
const GRANTS = `coalesce((
    select jsonb_agg(${GRANT_JSON} order by g.created_at, d.id)
    from account_token_grants g join databases d on d.id = g.database_id and d.deleted_at is null
    join projects p on p.id = d.project_id and p.deleted_at is null
    where g.account_token_id = t.id
), '[]')`;
const SELECT = `select t.id, t.account_id, t.name, t.role, t.expires_at, t.last_used_at, t.created_at, ${GRANTS} as grants from account_tokens t`;

export type TokenError = { readonly kind: 'not-found' } | { readonly kind: 'name-taken'; readonly name: string };
export type TokenGrantError = { readonly kind: 'token-not-found' } | { readonly kind: 'database-not-found' };

/** The Account's tokens that are not revoked, oldest first; expired ones too, so they can be rolled. */
export async function listAccountTokens(pool: pg.Pool | pg.PoolClient, accountId: Id): Promise<AccountToken[]> {
    const { rows } = await pool.query<TokenRow>(`${SELECT} where t.account_id = $1 and t.revoked_at is null order by t.created_at, t.id`, [accountId]);
    return rows.map(toToken);
}

const tokenById = async (client: pg.Pool | pg.PoolClient, accountId: Id, tokenId: Id): Promise<AccountToken | undefined> => {
    const { rows } = await client.query<TokenRow>(`${SELECT} where t.account_id = $1 and t.id = $2 and t.revoked_at is null`, [accountId, tokenId]);
    const row = rows[0];
    return row === undefined ? undefined : toToken(row);
};

/** A new token with only its first secret. The caller checks that `expiresAt` is allowed. */
export async function createAccountToken(
    pool: pg.Pool,
    accountId: Id,
    input: { readonly name: string; readonly role: AccountTokenRole | null; readonly expiresAt: Date },
): Promise<Result<AccountTokenWithSecret, TokenError>> {
    const secret = generateTokenSecret();
    const created = await unlessCodes(
        pool.query<{ id: string }>(
            `with t as (
                 insert into account_tokens (account_id, name, role, expires_at) values ($1, $2, $3, $4) returning id, expires_at
             ),
             s as (insert into account_token_secrets (hash, account_token_id, valid_until) select $5, id, expires_at from t)
             select id from t`,
            [accountId, input.name, input.role, input.expiresAt, hashOf(secret)],
        ),
        { [UNIQUE_VIOLATION]: { kind: 'name-taken', name: input.name } as const },
    );
    if (!created.ok) {
        return created;
    }
    const token = await tokenById(pool, accountId, created.value.rows[0]?.id ?? '');
    return token === undefined ? err({ kind: 'not-found' }) : ok({ ...token, secret });
}

/** Locks the token and tells whether it is one of the Account's, not revoked. */
const lockToken = async (client: pg.PoolClient, accountId: Id, tokenId: Id): Promise<boolean> => {
    await client.query(`select ${lockAccountToken('$1')}`, [tokenId]);
    const { rowCount } = await client.query('select 1 from account_tokens where account_id = $1 and id = $2 and revoked_at is null', [accountId, tokenId]);
    return rowCount === 1;
};

/**
 * Marks the token's Postgres roles that its role and grants no longer
 * allow: all of them once it is revoked or expired, none with a role, and
 * otherwise those on a Database without a grant or above its level. Run
 * under the token's lock after every change of its rights.
 */
async function dropUncovered(client: pg.PoolClient, tokenId: Id): Promise<DroppedRole[]> {
    const { rows } = await client.query<{ dropped: DroppedRole[] }>(
        `with token as (select id, role from account_tokens where id = $1 and revoked_at is null and expires_at > now()),
         dropped as (
             update database_roles r set dropped_at = now()
             from databases d
             where r.database_id = d.id and r.account_token_id = $1 and r.dropped_at is null
               and not exists (select 1 from token where role is not null)
               and not exists (
                   select 1 from account_token_grants g join token on token.id = g.account_token_id
                   where g.database_id = r.database_id and database_access_rank(g.access) >= database_access_rank(r.access)
               )
             returning r.id, r.access, d.project_id
         )
         select coalesce((select jsonb_agg(jsonb_build_object('id', id, 'projectId', project_id, 'access', access)) from dropped), '[]') as dropped`,
        [tokenId],
    );
    return rows[0]?.dropped ?? [];
}

/** A change to a token and the Postgres roles it took from it. */
export interface TokenChange<T> {
    readonly value: T;
    readonly dropped: readonly DroppedRole[];
}

/** Renames the token or changes its role; without a role, its Postgres roles its grants do not allow are dropped. */
export async function updateAccountToken(
    pool: pg.Pool,
    accountId: Id,
    tokenId: Id,
    patch: { readonly name?: string | undefined; readonly role?: AccountTokenRole | null | undefined },
): Promise<Result<TokenChange<AccountToken>, TokenError>> {
    return inTransaction(
        pool,
        async (client): Promise<Result<TokenChange<AccountToken>, TokenError>> => {
            if (!(await lockToken(client, accountId, tokenId))) {
                return err({ kind: 'not-found' });
            }
            const updated = await unlessCodes(
                client.query(
                    `update account_tokens set name = coalesce($3, name), role = case when $4 then $5 else role end
                     where account_id = $1 and id = $2`,
                    [accountId, tokenId, patch.name ?? null, patch.role !== undefined, patch.role ?? null],
                ),
                { [UNIQUE_VIOLATION]: { kind: 'name-taken', name: patch.name ?? '' } as const },
            );
            if (!updated.ok) {
                return updated;
            }
            const dropped = await dropUncovered(client, tokenId);
            const token = await tokenById(client, accountId, tokenId);
            return token === undefined ? err({ kind: 'not-found' }) : ok({ value: token, dropped });
        },
        (result) => result.ok,
    );
}

/**
 * A new secret valid until `expiresAt`, which becomes the token's expiry;
 * a secret still valid keeps working for ROLL_OVERLAP at most. Name, rights
 * and Postgres roles stay, so a BI tool's saved connection survives.
 */
export async function rollAccountToken(pool: pg.Pool, accountId: Id, tokenId: Id, expiresAt: Date): Promise<Result<AccountTokenWithSecret, TokenError>> {
    const secret = generateTokenSecret();
    return inTransaction(
        pool,
        async (client): Promise<Result<AccountTokenWithSecret, TokenError>> => {
            if (!(await lockToken(client, accountId, tokenId))) {
                return err({ kind: 'not-found' });
            }
            const { rows } = await client.query<{ previous: Date | null }>(
                `with old as (
                     update account_token_secrets set valid_until = least(valid_until, now() + $4::interval)
                     where account_token_id = $1 and valid_until > now()
                       and exists (select 1 from account_tokens where id = $1 and expires_at > now())
                     returning valid_until
                 ),
                 gone as (
                     delete from account_token_secrets where account_token_id = $1
                       and (valid_until <= now() or not exists (select 1 from account_tokens where id = $1 and expires_at > now()))
                 ),
                 added as (insert into account_token_secrets (hash, account_token_id, valid_until) values ($2, $1, $3)),
                 token as (update account_tokens set expires_at = $3 where id = $1)
                 select (select max(valid_until) from old) as previous`,
                [tokenId, hashOf(secret), expiresAt, ROLL_OVERLAP],
            );
            const token = await tokenById(client, accountId, tokenId);
            const previous = rows[0]?.previous ?? null;
            return token === undefined
                ? err({ kind: 'not-found' })
                : ok({ ...token, secret, ...(previous === null ? {} : { previousSecretValidUntil: previous.toISOString() }) });
        },
        (result) => result.ok,
    );
}

/** Revokes the token: its secrets go at once, its Postgres roles are marked to be dropped. */
export async function revokeAccountToken(pool: pg.Pool, accountId: Id, tokenId: Id): Promise<Result<readonly DroppedRole[], TokenError>> {
    return inTransaction(
        pool,
        async (client): Promise<Result<readonly DroppedRole[], TokenError>> => {
            if (!(await lockToken(client, accountId, tokenId))) {
                return err({ kind: 'not-found' });
            }
            await client.query(
                `with revoked as (update account_tokens set revoked_at = now() where id = $1)
                 delete from account_token_secrets where account_token_id = $1`,
                [tokenId],
            );
            return ok(await dropUncovered(client, tokenId));
        },
        (result) => result.ok,
    );
}

/** Gives the token a grant on a live Database of the Account, or another level; a lower one drops its roles above it while it has no role. */
export async function setTokenGrant(
    pool: pg.Pool,
    accountId: Id,
    tokenId: Id,
    databaseId: Id,
    access: DatabaseAccess,
): Promise<Result<TokenChange<Grant> & { readonly created: boolean }, TokenGrantError>> {
    return inTransaction(
        pool,
        async (client): Promise<Result<TokenChange<Grant> & { readonly created: boolean }, TokenGrantError>> => {
            if (!(await lockToken(client, accountId, tokenId))) {
                return err({ kind: 'token-not-found' });
            }
            const { rows } = await client.query<{ grant: GrantJson; created: boolean }>(
                `with g as (
                     insert into account_token_grants (account_token_id, database_id, access)
                     select $2, d.id, $4 from databases d join projects p on p.id = d.project_id
                     where d.id = $3 and p.account_id = $1 and d.deleted_at is null and p.deleted_at is null
                     on conflict (account_token_id, database_id) do update set access = excluded.access
                     returning access, created_at, database_id, (xmax = 0) as created
                 )
                 select ${GRANT_JSON} as grant, g.created
                 from g join databases d on d.id = g.database_id join projects p on p.id = d.project_id`,
                [accountId, tokenId, databaseId, access],
            );
            const row = rows[0];
            if (row === undefined) {
                return err({ kind: 'database-not-found' });
            }
            return ok({ value: toGrant(row.grant), created: row.created, dropped: await dropUncovered(client, tokenId) });
        },
        (result) => result.ok,
    );
}

/** Takes the token's grant on the Database away, and with it its Postgres roles there while it has no role. */
export async function removeTokenGrant(pool: pg.Pool, accountId: Id, tokenId: Id, databaseId: Id): Promise<Result<readonly DroppedRole[], TokenGrantError>> {
    return inTransaction(
        pool,
        async (client): Promise<Result<readonly DroppedRole[], TokenGrantError>> => {
            if (!(await lockToken(client, accountId, tokenId))) {
                return err({ kind: 'token-not-found' });
            }
            const deleted = await client.query('delete from account_token_grants where account_token_id = $1 and database_id = $2', [tokenId, databaseId]);
            return deleted.rowCount === 0 ? err({ kind: 'database-not-found' }) : ok(await dropUncovered(client, tokenId));
        },
        (result) => result.ok,
    );
}

/** Who a secret belongs to, for the API's authentication. */
export interface TokenCaller {
    readonly tokenId: Id;
    readonly accountId: Id;
    readonly role: AccountTokenRole | null;
}

/**
 * The token a secret belongs to: `unknown` for no token, a revoked one or a
 * secret rolled away more than ROLL_OVERLAP ago; `expired` past the token's
 * expiry. Records the use, at most once per LAST_USE_PRECISION.
 */
export async function tokenBySecret(pool: pg.Pool, secret: string): Promise<Result<TokenCaller, 'unknown' | 'expired'>> {
    const { rows } = await pool.query<{ id: string; account_id: string; role: AccountTokenRole | null; live: boolean; valid: boolean }>(
        `select t.id, t.account_id, t.role, t.expires_at > now() as live, s.valid_until > now() as valid
         from account_token_secrets s join account_tokens t on t.id = s.account_token_id
         where s.hash = $1 and t.revoked_at is null`,
        [hashOf(secret)],
    );
    const row = rows[0];
    if (row === undefined) {
        return err('unknown');
    }
    if (!row.live) {
        return err('expired');
    }
    if (!row.valid) {
        return err('unknown');
    }
    await pool.query(
        `update account_tokens set last_used_at = now()
         where id = $1 and (last_used_at is null or last_used_at < now() - $2::interval)`,
        [row.id, LAST_USE_PRECISION],
    );
    return ok({ tokenId: row.id, accountId: row.account_id, role: row.role });
}

/** The token's grants that count: on live Databases, while it has no role. */
export async function tokenGrantsOf(pool: pg.Pool, tokenId: Id): Promise<CallerGrant[]> {
    const { rows } = await pool.query<{ account_id: string; project_id: string; database_id: string; access: DatabaseAccess }>(
        `select t.account_id, d.project_id, d.id as database_id, g.access
         from account_tokens t join account_token_grants g on g.account_token_id = t.id
         join databases d on d.id = g.database_id and d.deleted_at is null
         join projects p on p.id = d.project_id and p.deleted_at is null and p.account_id = t.account_id
         where t.id = $1 and t.role is null and t.revoked_at is null
         order by d.project_id, d.id`,
        [tokenId],
    );
    return rows.map((row) => ({ accountId: row.account_id, projectId: row.project_id, databaseId: row.database_id, access: row.access }));
}

/**
 * Marks the Postgres roles of expired tokens, for the cleanup pass: an
 * expired token cannot open a tunnel any more, and its roles go as those of
 * a revoked one. A roll afterwards gets new roles on the next ask. The
 * secrets pass deletes their Secrets and ends open `owner` sessions.
 */
export async function dropExpiredTokenRoles(pool: pg.Pool): Promise<number> {
    const { rowCount } = await pool.query(
        `update database_roles r set dropped_at = now()
         from account_tokens t
         where r.account_token_id = t.id and r.dropped_at is null and t.expires_at <= now()`,
    );
    return rowCount ?? 0;
}
