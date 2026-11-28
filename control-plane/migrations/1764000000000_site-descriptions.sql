-- Up Migration

-- What people call a Site (ADR-0009): display text, set by the
-- installation's admins on the dashboard's "Sites & nodes" page. Placement
-- reads only the nodes' labels; a Site whose nodes are gone keeps its
-- description for when they come back.
create table site_descriptions (
    site text primary key check (site ~ '^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$'),
    description text not null check (description = btrim(description) and length(description) between 1 and 100),
    updated_at timestamptz not null default now()
);

-- Down Migration

drop table site_descriptions;
