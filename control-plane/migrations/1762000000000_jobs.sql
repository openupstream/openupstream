-- Up Migration

-- Jobs (ARCHITECTURE.md, "Containers"; decision 95): an image run to
-- completion, on a schedule (a Cron job) or started through the API (a
-- One-off job). As for Services, the API resolves the image's tag to a
-- digest before it inserts or updates a row. The API checks command, args,
-- schedule and time zone in detail; the schema keeps their shape and size.
create table jobs (
    id uuid primary key default gen_random_uuid(),
    project_id uuid not null references projects (id) on delete cascade,
    name text not null check (name ~ '^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'),
    image text not null check (length(image) between 1 and 512),
    image_digest text not null check (image_digest ~ '^sha256:[0-9a-f]{64}$'),
    deployed_at timestamptz not null default now(),
    -- JSON arrays of strings; null: the image's entrypoint and command.
    command jsonb check (jsonb_typeof(command) = 'array'),
    args jsonb check (jsonb_typeof(args) = 'array'),
    memory_mb integer not null check (memory_mb > 0),
    cpu_millicores integer not null check (cpu_millicores > 0),
    timeout_seconds integer not null check (timeout_seconds between 1 and 86400),
    -- null: started only through the API.
    schedule text check (length(schedule) between 1 and 200),
    -- IANA name; null: UTC. Only with a schedule.
    time_zone text check (length(time_zone) between 1 and 64),
    home_site text check (home_site in ('hetzner-fsn1', 'ovh-lim')),
    -- Sealed with the Project's data key, as for a Service.
    registry_auth bytea,
    created_at timestamptz not null default now(),
    unique (project_id, name),
    check (time_zone is null or schedule is not null)
);

-- The same checks as for Services and the other Resources.
create trigger jobs_project_alive before insert or update of project_id on jobs
    for each row execute function services_project_alive();
create trigger jobs_account_not_held before insert on jobs
    for each row execute function resource_account_not_held();

-- Down Migration

drop table jobs;
