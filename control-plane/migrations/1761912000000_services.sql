-- Up Migration

-- What deploying a Service needs (ARCHITECTURE.md, "Containers"). The API
-- resolves the image's tag to a digest before it inserts or updates a row,
-- so every row has one; deployed_at is when that last happened. No Service
-- existed before this migration.
alter table services alter column image_digest set not null;
alter table services add constraint services_image_length check (length(image) <= 512);
alter table services add column deployed_at timestamptz not null default now();
-- Where a single replica runs; null: the Home site of the Project's oldest
-- Database, or hetzner-fsn1.
alter table services add column home_site text check (home_site in ('hetzner-fsn1', 'ovh-lim'));
-- Registry credentials, sealed with the Project's data key like a Secret's
-- value (control-plane/src/secrets); null: the image is pulled anonymously.
alter table services add column registry_auth bytea;

-- As for Databases and Buckets: a deleted Project holds no new Service.
create function services_project_alive() returns trigger language plpgsql as $$
begin
    if exists (select 1 from projects where id = new.project_id and deleted_at is not null) then
        raise exception 'project % is deleted', new.project_id using errcode = 'foreign_key_violation';
    end if;
    return new;
end
$$;

create trigger services_project_alive before insert or update of project_id on services
    for each row execute function services_project_alive();

-- Down Migration

drop trigger services_project_alive on services;
drop function services_project_alive();
alter table services drop column registry_auth;
alter table services drop column home_site;
alter table services drop column deployed_at;
alter table services drop constraint services_image_length;
alter table services alter column image_digest drop not null;
