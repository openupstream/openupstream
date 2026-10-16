-- Up Migration

-- Build step 0: Accounts, Projects, Resources, Secrets, the routing table and
-- usage events. Terms are those of GLOSSARY.md; the API types are in
-- sdk/src/model.ts.
--
-- Deleting a Project cascades to every row that belongs to it, except
-- usage_events, which billing still needs after the Project is gone.

create table accounts (
    id uuid primary key default gen_random_uuid(),
    name text not null check (length(name) between 1 and 200),
    created_at timestamptz not null default now()
);

create table members (
    id uuid primary key default gen_random_uuid(),
    account_id uuid not null references accounts (id) on delete cascade,
    auth_subject text not null check (length(auth_subject) > 0),
    email text not null check (position('@' in email) > 1),
    created_at timestamptz not null default now(),
    unique (account_id, auth_subject)
);

-- An Account cannot be deleted while it still has Projects: deleting a
-- Project tears down its namespace and is done one Project at a time.
create table projects (
    id uuid primary key default gen_random_uuid(),
    account_id uuid not null references accounts (id) on delete restrict,
    name text not null check (name ~ '^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'),
    created_at timestamptz not null default now(),
    unique (account_id, name)
);

create table databases (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references projects (id) on delete cascade,
    name text not null check (name ~ '^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'),
    home_site text not null default 'hetzner-fsn1' check (home_site in ('hetzner-fsn1', 'ovh-lim')),
    memory_mb integer not null check (memory_mb >= 256),
    storage_gb integer not null check (storage_gb > 0),
    created_at timestamptz not null default now(),
    unique (project_id, name)
);

-- Bucket names are hostnames (<bucket>.s3.<customer domain>), so they are
-- unique across all Projects. (id, project_id) is unique so Routes can
-- reference a Bucket together with its Project.
create table buckets (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references projects (id) on delete cascade,
    name text not null unique check (name ~ '^[a-z0-9]([a-z0-9-]{1,61}[a-z0-9])$'),
    created_at timestamptz not null default now(),
    unique (id, project_id)
);

create table services (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references projects (id) on delete cascade,
    name text not null check (name ~ '^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'),
    image text not null check (length(image) > 0),
    image_digest text check (image_digest ~ '^sha256:[0-9a-f]{64}$'),
    replicas integer not null default 1 check (replicas >= 1),
    memory_mb integer not null check (memory_mb > 0),
    cpu_millicores integer not null check (cpu_millicores > 0),
    port integer not null check (port between 1 and 65535),
    created_at timestamptz not null default now(),
    unique (project_id, name),
    unique (id, project_id)
);

-- Secrets: each value is encrypted with its Project's data key; the data key
-- is stored wrapped by the key-encryption key named in kek_id
-- (control-plane/src/secrets).
create table project_data_keys (
    project_id uuid primary key references projects (id) on delete cascade,
    kek_id text not null check (length(kek_id) > 0),
    wrapped_key bytea not null,
    created_at timestamptz not null default now()
);

-- A data key that still protects Secrets cannot be deleted (checked at commit,
-- so deleting the Project, which removes both, is not refused).
create table secrets (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references projects (id) on delete cascade,
    name text not null check (name ~ '^[A-Za-z_][A-Za-z0-9_]{0,254}$'),
    ciphertext bytea not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (project_id, name),
    foreign key (project_id) references project_data_keys (project_id) deferrable initially deferred
);

-- A Domain is either the Project's default hostname (always verified) or a
-- custom domain, which is routed only after its TXT proof. Pending claims do
-- not reserve the hostname, so nobody can squat a hostname they do not own;
-- the partial unique index lets only one verified Domain per hostname exist.
-- A Domain that is deleted and claimed again gets a new row and a new token.
create table domains (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references projects (id) on delete cascade,
    hostname text not null check (
        length(hostname) <= 253
        and hostname ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
    ),
    kind text not null check (kind in ('default', 'custom')),
    verification_token text unique check (length(verification_token) >= 32),
    verified_at timestamptz,
    created_at timestamptz not null default now(),
    unique (project_id, hostname),
    unique (id, project_id),
    check (
        (kind = 'default' and verification_token is null and verified_at is not null)
        or (kind = 'custom' and verification_token is not null)
    )
);

create unique index domains_verified_hostname_key on domains (hostname) where verified_at is not null;
create unique index domains_one_default_per_project_key on domains (project_id) where kind = 'default';

-- The routing table. project_id is carried on every Route so the composite
-- foreign keys pin the Domain, the Bucket and the Service to the same
-- Project. Deleting a Domain removes its Routes; deleting a Bucket or Service
-- that a Route still targets is refused. Those two keys are checked at commit,
-- so deleting a Project, which removes the Routes through its Domains in the
-- same statement, is not refused.
create table routes (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null,
    domain_id uuid not null,
    path_prefix text not null check (path_prefix ~ '^(/|(/[A-Za-z0-9._~-]+)+)$'),
    bucket_id uuid,
    service_id uuid,
    spa_fallback boolean not null default false,
    created_at timestamptz not null default now(),
    unique (domain_id, path_prefix),
    foreign key (domain_id, project_id) references domains (id, project_id) on delete cascade,
    foreign key (bucket_id, project_id) references buckets (id, project_id) deferrable initially deferred,
    foreign key (service_id, project_id) references services (id, project_id) deferrable initially deferred,
    check (num_nonnulls(bucket_id, service_id) = 1),
    check (not spa_fallback or bucket_id is not null)
);

create index routes_bucket_id_idx on routes (bucket_id) where bucket_id is not null;
create index routes_service_id_idx on routes (service_id) where service_id is not null;

-- Usage events are append-only and outlive their Project and Resource: the
-- last hours of a deleted Resource are still billed. account_id is kept so the
-- rollup can bill an Account after the Project is gone. No foreign keys, on
-- purpose. One event per Resource, unit and interval start, so an emitter
-- that retries (insert … on conflict do nothing) cannot bill twice.
create table usage_events (
    id bigint generated always as identity primary key,
    account_id uuid not null,
    project_id uuid not null,
    resource_kind text not null check (resource_kind in ('database', 'bucket', 'service')),
    resource_id uuid not null,
    unit text not null check (unit in ('cpu_seconds', 'memory_gb_hours', 'storage_gb_hours', 'egress_gb')),
    quantity numeric not null check (quantity >= 0),
    interval_start timestamptz not null,
    interval_end timestamptz not null,
    recorded_at timestamptz not null default now(),
    check (interval_end > interval_start),
    unique (resource_id, unit, interval_start)
);

create index usage_events_interval_start_idx on usage_events (interval_start);
create index usage_events_project_id_idx on usage_events (project_id, interval_start);

create function usage_events_append_only() returns trigger
language plpgsql as $$
begin
    raise exception 'usage_events is append-only (% refused)', tg_op
        using errcode = 'restrict_violation';
end
$$;

create trigger usage_events_no_update_or_delete
    before update or delete on usage_events
    for each row execute function usage_events_append_only();

create trigger usage_events_no_truncate
    before truncate on usage_events
    for each statement execute function usage_events_append_only();

-- Down Migration

drop table usage_events;
drop function usage_events_append_only();
drop table routes;
drop table domains;
drop table secrets;
drop table project_data_keys;
drop table services;
drop table buckets;
drop table databases;
drop table projects;
drop table members;
drop table accounts;
