-- Up Migration

-- madAuth's `user.api_key_revoked`, passed on by its sidecar (ARCHITECTURE.md,
-- decision 143; docs/adr/0006-invitations-roles-account-tokens.md). The
-- control plane reuses madAuth's answer about an API key for a minute
-- (decision 64), so a revoked key could still ask for a Postgres role in
-- that minute, after its roles were marked: role creation refuses the keys
-- listed here. Rows stay; a key id is never reused.
create table revoked_api_keys (
    api_key_id text primary key check (length(api_key_id) > 0),
    auth_subject text not null check (length(auth_subject) > 0),
    revoked_at timestamptz not null default now()
);

-- madAuth's `user.deleted`: madAuth cannot be kept from deleting a user, so
-- removing their Members may leave an Account without an owner. Only that
-- removal sets `openupstream.owner_may_go` for its transaction; every other
-- change still keeps an owner.
create or replace function members_keep_an_owner() returns trigger language plpgsql as $$
begin
    if old.role = 'owner' and (tg_op = 'DELETE' or new.role is distinct from 'owner')
       and coalesce(current_setting('openupstream.owner_may_go', true), '') <> 'on' then
        -- no key update: other changes to the Account wait, but not inserts that only reference it.
        perform 1 from accounts where id = old.account_id for no key update;
        if found and not exists (
            select 1 from members where account_id = old.account_id and role = 'owner' and id <> old.id
        ) then
            raise exception 'account % would have no owner', old.account_id using errcode = 'OUOWN';
        end if;
    end if;
    return case when tg_op = 'DELETE' then old else new end;
end
$$;

-- Down Migration

create or replace function members_keep_an_owner() returns trigger language plpgsql as $$
begin
    if old.role = 'owner' and (tg_op = 'DELETE' or new.role is distinct from 'owner') then
        perform 1 from accounts where id = old.account_id for no key update;
        if found and not exists (
            select 1 from members where account_id = old.account_id and role = 'owner' and id <> old.id
        ) then
            raise exception 'account % would have no owner', old.account_id using errcode = 'OUOWN';
        end if;
    end if;
    return case when tg_op = 'DELETE' then old else new end;
end
$$;
drop table revoked_api_keys;
