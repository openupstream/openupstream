-- Up Migration

-- A restored Database starts as a copy of another Database of its Project at
-- a point in time (ARCHITECTURE.md, decisions 51 and 108). The operator
-- renders its Cluster's recovery bootstrap from these columns until the
-- cleanup pass records the restore as finished (its Cluster had a ready
-- instance); from then on the Cluster no longer names the source's
-- ObjectStore, which the cleanup deletes after the source's retention
-- window. The source and time stay, to show where the Database came from.
-- No foreign key: the source's row goes with its backups. A null target
-- time is the latest point the source's archive reaches.
alter table databases add column restore_source_id uuid;
alter table databases add column restore_target_time timestamptz;
alter table databases add column restore_finished_at timestamptz;
alter table databases add constraint databases_restore_finished_needs_source
    check (restore_finished_at is null or restore_source_id is not null);
alter table databases add constraint databases_restore_target_needs_source
    check (restore_target_time is null or restore_source_id is not null);
alter table databases add constraint databases_restore_not_self
    check (restore_source_id is distinct from id);

-- Down Migration

alter table databases drop constraint databases_restore_finished_needs_source;
alter table databases drop constraint databases_restore_not_self;
alter table databases drop constraint databases_restore_target_needs_source;
alter table databases drop column restore_finished_at;
alter table databases drop column restore_target_time;
alter table databases drop column restore_source_id;
