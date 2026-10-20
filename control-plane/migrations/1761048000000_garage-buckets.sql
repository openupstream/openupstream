-- Up Migration

-- A Bucket is a Garage bucket with the Bucket's name as its global alias,
-- and a Garage key of its own that may read and write that bucket only
-- (ARCHITECTURE.md, decisions 81 and 82). The API creates both in Garage
-- before the row is committed, so every row has them. No Bucket existed
-- before this migration.
alter table buckets add column garage_bucket_id text not null;
alter table buckets add column access_key_id text not null;

-- Deleting a Bucket first marks it deleted; the cleanup deletes its key,
-- its objects and the Garage bucket, then the row. The name stays taken
-- until then, as it does in Garage.
alter table buckets add column deleted_at timestamptz;
create index buckets_deleted_at on buckets (deleted_at) where deleted_at is not null;

-- As for Databases: a deleted Project holds no live Bucket.
create function buckets_project_alive() returns trigger language plpgsql as $$
begin
    if new.deleted_at is null and exists (
        select 1 from projects where id = new.project_id and deleted_at is not null
    ) then
        raise exception 'project % is deleted', new.project_id using errcode = 'foreign_key_violation';
    end if;
    return new;
end
$$;

create trigger buckets_project_alive before insert or update of deleted_at, project_id on buckets
    for each row execute function buckets_project_alive();

-- Down Migration

drop trigger buckets_project_alive on buckets;
drop function buckets_project_alive();
drop index buckets_deleted_at;
alter table buckets drop column deleted_at;
alter table buckets drop column access_key_id;
alter table buckets drop column garage_bucket_id;
