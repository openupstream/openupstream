-- Up Migration

-- Member roles (ARCHITECTURE.md, decision 138;
-- docs/adr/0006-invitations-roles-account-tokens.md): `owner` may do
-- everything, the Account's Members included; `developer` every Project and
-- everything in it. A Member without a role reaches only what grants give
-- (decision 139, not built yet), so nothing today. Every Member so far
-- created their Account, so they become its owners.
alter table members add column role text check (role in ('owner', 'developer'));
update members set role = 'owner';

-- An Account always keeps an owner: the last one cannot leave, be removed
-- or lose the role. Checked here, not in the API, so no route can forget
-- it; the Account's row is locked first, so two owners demoting each other
-- at once cannot both succeed. Deleting the Account itself (a cascade, its
-- row already gone) is not stopped.
create function members_keep_an_owner() returns trigger language plpgsql as $$
begin
    if old.role = 'owner' and (tg_op = 'DELETE' or new.role is distinct from 'owner') then
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

create trigger members_keep_an_owner before update of role or delete on members
    for each row execute function members_keep_an_owner();

-- A Postgres role its caller may no longer use (decision 143) is marked,
-- not deleted: the Databases operator keeps rendering it as
-- `ensure: absent`, so CloudNativePG drops it whenever the Cluster is
-- there to do so, and the row goes with its Database. A marked role is no
-- longer the caller's, so one level given back gets a new role.
alter table database_roles add column dropped_at timestamptz;
-- An open `owner` session acts as `app` and outlives its role: the
-- control plane ends it by deleting the Project's tunnel pods, and records
-- that it did, so the secrets pass retries a delete that failed.
alter table database_roles add column sessions_ended_at timestamptz;
drop index database_roles_caller;
create unique index database_roles_caller on database_roles (database_id, auth_subject, coalesce(api_key_id, ''), access)
    where dropped_at is null;

-- Down Migration

drop index database_roles_caller;
delete from database_roles where dropped_at is not null;
create unique index database_roles_caller on database_roles (database_id, auth_subject, coalesce(api_key_id, ''), access);
alter table database_roles drop column sessions_ended_at;
alter table database_roles drop column dropped_at;
drop trigger members_keep_an_owner on members;
drop function members_keep_an_owner();
alter table members drop column role;
