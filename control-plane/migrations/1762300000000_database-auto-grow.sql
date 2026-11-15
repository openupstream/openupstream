-- Up Migration

-- Storage that grows by itself (ARCHITECTURE.md, decision 111): on by
-- default, without a maximum unless the customer sets one; auto_grow false
-- leaves resizing to the customer. The growth pass raises storage_gb by
-- half once a volume is 90% used, never past max_storage_gb.
alter table databases add column auto_grow boolean not null default true;
alter table databases add column max_storage_gb integer;
alter table databases add constraint databases_max_storage_gb
    check (max_storage_gb is null or max_storage_gb >= storage_gb);

-- Down Migration

alter table databases drop constraint databases_max_storage_gb;
alter table databases drop column max_storage_gb;
alter table databases drop column auto_grow;
