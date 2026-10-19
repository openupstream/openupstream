-- Up Migration

-- A Hold stops an Account from creating Resources (ARCHITECTURE.md, decision
-- 78). Whoever runs the platform places and lifts them through the internal
-- API, e.g. the billing service until the Account has a payment method;
-- the reason is that service's own short name for why. An Account without
-- Holds may create Resources. Existing Resources keep running.
create table account_holds (
    account_id uuid not null references accounts (id) on delete cascade,
    reason text not null check (reason ~ '^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'),
    created_at timestamptz not null default now(),
    primary key (account_id, reason)
);

-- Every kind of Resource is refused here, not in each API route, so a new
-- route cannot forget it and the check runs in the inserting statement.
create function resource_account_not_held() returns trigger language plpgsql as $$
begin
    if exists (
        select 1 from account_holds h join projects p on p.account_id = h.account_id where p.id = new.project_id
    ) then
        raise exception 'the Account of project % has a Hold', new.project_id using errcode = 'OUHLD';
    end if;
    return new;
end
$$;

create trigger databases_account_not_held before insert on databases
    for each row execute function resource_account_not_held();
create trigger buckets_account_not_held before insert on buckets
    for each row execute function resource_account_not_held();
create trigger services_account_not_held before insert on services
    for each row execute function resource_account_not_held();

-- Down Migration

drop trigger services_account_not_held on services;
drop trigger buckets_account_not_held on buckets;
drop trigger databases_account_not_held on databases;
drop function resource_account_not_held();
drop table account_holds;
