-- Up Migration

-- Database access from outside the cluster (ARCHITECTURE.md, decision 126;
-- docs/adr/0005-database-access-from-outside.md): a caller's own Postgres
-- role per Database and access level. The caller is a madAuth user, and
-- for an API key also the key, which gets roles of its own. The password
-- is sealed with the Project's data key like a Secret (bound to the name
-- `database-role/<id>`), since the control plane returns it on every ask
-- and writes the Secret CloudNativePG reads it from.
create table database_roles (
    id uuid primary key,
    database_id uuid not null references databases (id) on delete cascade,
    auth_subject text not null check (length(auth_subject) > 0),
    api_key_id text check (api_key_id is null or length(api_key_id) > 0),
    access text not null check (access in ('read', 'write', 'owner')),
    password bytea not null,
    created_at timestamptz not null default now()
);

-- One role per caller, Database and level.
create unique index database_roles_caller on database_roles (database_id, auth_subject, coalesce(api_key_id, ''), access);

-- Down Migration

drop table database_roles;
