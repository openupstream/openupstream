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

-- Down Migration

drop table account_holds;
