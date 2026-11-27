-- Up Migration

-- Grants (ARCHITECTURE.md, decisions 139 and 140;
-- docs/adr/0006-invitations-roles-account-tokens.md): access for one Member
-- to one Database at a level. A Member with a role needs none; theirs are
-- kept, and count once the role goes. A grant goes with its Member and its
-- Database. Account tokens (decision 144) get grants of their own later.
create table grants (
    member_id uuid not null references members (id) on delete cascade,
    database_id uuid not null references databases (id) on delete cascade,
    access text not null check (access in ('read', 'write', 'owner')),
    created_at timestamptz not null default now(),
    primary key (member_id, database_id)
);
create index grants_database on grants (database_id);

-- The order of the levels: a grant allows its level and those below it.
create function database_access_rank(access text) returns int language sql immutable as $$
    select array_position(array['read', 'write', 'owner'], access)
$$;

-- Down Migration

drop function database_access_rank(text);
drop table grants;
