-- Up Migration

-- Account tokens (ARCHITECTURE.md, decision 144;
-- docs/adr/0006-invitations-roles-account-tokens.md): a named secret that
-- belongs to the Account, not to a person, with the developer role or
-- grants, never owner. A revoked token's row stays, marked: the Postgres
-- roles it had keep pointing at it while the Databases operator drops them.
create table account_tokens (
    id uuid primary key default gen_random_uuid(),
    account_id uuid not null references accounts (id) on delete cascade,
    name text not null check (name ~ '^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'),
    -- null: only what its grants give.
    role text check (role in ('developer')),
    expires_at timestamptz not null,
    last_used_at timestamptz,
    created_at timestamptz not null default now(),
    revoked_at timestamptz
);
create unique index account_tokens_name on account_tokens (account_id, name) where revoked_at is null;

-- The SHA-256 of each secret (`oup_tok_…`, 32 random bytes), never the
-- secret. A roll adds a secret and keeps the old one for 24 hours, so a
-- token has one or two.
create table account_token_secrets (
    hash bytea primary key check (length(hash) = 32),
    account_token_id uuid not null references account_tokens (id) on delete cascade,
    valid_until timestamptz not null
);
create index account_token_secrets_token on account_token_secrets (account_token_id);

-- A token's grants (decision 139), as a Member's: they count while the
-- token has no role, and go with their Database.
create table account_token_grants (
    account_token_id uuid not null references account_tokens (id) on delete cascade,
    database_id uuid not null references databases (id) on delete cascade,
    access text not null check (access in ('read', 'write', 'owner')),
    created_at timestamptz not null default now(),
    primary key (account_token_id, database_id)
);
create index account_token_grants_database on account_token_grants (database_id);

-- A token's own Postgres roles (decision 126): the caller is either a
-- madAuth user (with one of their API keys or not) or an Account token.
alter table database_roles alter column auth_subject drop not null;
alter table database_roles add column account_token_id uuid references account_tokens (id) on delete cascade;
alter table database_roles add constraint database_roles_one_caller
    check ((auth_subject is null) <> (account_token_id is null) and (api_key_id is null or auth_subject is not null));
drop index database_roles_caller;
create unique index database_roles_caller
    on database_roles (database_id, coalesce(auth_subject, ''), coalesce(api_key_id, ''), coalesce(account_token_id::text, ''), access)
    where dropped_at is null;

-- Down Migration

drop index database_roles_caller;
delete from database_roles where account_token_id is not null;
create unique index database_roles_caller on database_roles (database_id, auth_subject, coalesce(api_key_id, ''), access)
    where dropped_at is null;
alter table database_roles drop constraint database_roles_one_caller;
alter table database_roles drop column account_token_id;
alter table database_roles alter column auth_subject set not null;
drop table account_token_grants;
drop table account_token_secrets;
drop table account_tokens;
