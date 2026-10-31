-- Up Migration

-- The waitlist (ARCHITECTURE.md, decision 86): while sign-up on the hosted
-- service is closed, people leave their e-mail address to hear when it
-- opens. Double opt-in: an address is on the list only once the link in its
-- confirmation e-mail was used (confirmed_at); until then the cleanup
-- deletes it 48 hours after its e-mail. Removing an address deletes its row,
-- nothing is kept.
create table waitlist (
    email text primary key check (email = lower(email) and length(email) <= 254),
    -- SHA-256 of the token in the links of the latest e-mail (confirm,
    -- remove). The token itself is never stored, so a copy of this table
    -- confirms or removes nobody.
    token_hash bytea not null unique check (length(token_hash) = 32),
    -- Which consent text the address was given with (src/waitlist/site.ts).
    consent text not null,
    requested_at timestamptz not null default now(),
    mailed_at timestamptz not null default now(),
    confirmed_at timestamptz
);

create index waitlist_unconfirmed on waitlist (mailed_at) where confirmed_at is null;

-- Down Migration

drop table waitlist;
