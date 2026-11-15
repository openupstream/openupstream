-- Up Migration

-- Metering (ARCHITECTURE.md, "Metering and billing"; decision 112): Jobs
-- are Resources of their own, and every hour the metering pass has
-- recorded is listed, so it knows where to go on after a restart or a
-- Prometheus outage, and the billing service knows when a month is
-- complete.
alter table usage_events drop constraint usage_events_resource_kind_check;
alter table usage_events add constraint usage_events_resource_kind_check
    check (resource_kind in ('database', 'bucket', 'service', 'job'));

create table metered_hours (
    hour timestamptz primary key check (extract(epoch from hour) % 3600 = 0),
    metered_at timestamptz not null default now()
);

-- Down Migration

drop table metered_hours;
-- Usage events are append-only, so events of Jobs stay; the old rule holds
-- for new rows only.
alter table usage_events drop constraint usage_events_resource_kind_check;
alter table usage_events add constraint usage_events_resource_kind_check
    check (resource_kind in ('database', 'bucket', 'service')) not valid;
