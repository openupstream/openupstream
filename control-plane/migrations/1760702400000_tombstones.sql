-- Up Migration

-- Deleting a Project or Database first marks it deleted (ARCHITECTURE.md,
-- decision 58). The operator no longer sees it; the control plane's cleanup
-- removes its Kubernetes objects, keeps its backups for the retention window
-- and only then removes the row. A deleted name can be used again at once.

alter table projects add column deleted_at timestamptz;
alter table databases add column deleted_at timestamptz;
-- When the cleanup removed the Database's Cluster, Pooler and
-- ScheduledBackup; its ObjectStore and backups stay for the retention window.
alter table databases add column objects_removed_at timestamptz check (objects_removed_at is null or deleted_at is not null);

alter table projects drop constraint projects_account_id_name_key;
create unique index projects_account_id_name_key on projects (account_id, name) where deleted_at is null;

alter table databases drop constraint databases_project_id_name_key;
create unique index databases_project_id_name_key on databases (project_id, name) where deleted_at is null;

-- What the cleanup works through, oldest first.
create index databases_deleted_at on databases (deleted_at) where deleted_at is not null;
create index projects_deleted_at on projects (deleted_at) where deleted_at is not null;

-- A deleted Project holds no live Database: deleting the Project marks its
-- Databases deleted in the same statement, and no Database can be created in
-- or restored into a deleted Project.
create function databases_project_alive() returns trigger language plpgsql as $$
begin
    if new.deleted_at is null and exists (
        select 1 from projects where id = new.project_id and deleted_at is not null
    ) then
        raise exception 'project % is deleted', new.project_id using errcode = 'foreign_key_violation';
    end if;
    return new;
end
$$;

create trigger databases_project_alive before insert or update of deleted_at, project_id on databases
    for each row execute function databases_project_alive();

-- Down Migration

drop trigger databases_project_alive on databases;
drop function databases_project_alive();
drop index projects_deleted_at;
drop index databases_deleted_at;
drop index databases_project_id_name_key;
alter table databases add constraint databases_project_id_name_key unique (project_id, name);
drop index projects_account_id_name_key;
alter table projects add constraint projects_account_id_name_key unique (account_id, name);
alter table databases drop column objects_removed_at;
alter table databases drop column deleted_at;
alter table projects drop column deleted_at;
