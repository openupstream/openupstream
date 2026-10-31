-- Up Migration

-- The waitlist (ARCHITECTURE.md, decision 86): while sign-up on the hosted
-- service is closed, people leave their e-mail address to hear when it
-- opens. Double opt-in: an address is on the list only once the link in a
-- confirmation e-mail was used (confirmed_at); until then the cleanup
-- deletes it 48 hours after its last e-mail. Removing an address deletes its
-- row and its tokens, nothing is kept.
create table waitlist (
    email text primary key check (email = lower(email) and length(email) <= 254),
    -- Which consent text the address was given with (src/waitlist/site.ts).
    consent text not null,
    requested_at timestamptz not null default now(),
    mailed_at timestamptz not null default now(),
    confirmed_at timestamptz
);

create index waitlist_unconfirmed on waitlist (mailed_at) where confirmed_at is null;

-- The tokens in the links of an address's e-mails (confirm, remove), one
-- per e-mail, as SHA-256: a copy of this table confirms or removes nobody.
-- A new e-mail adds one, so someone else asking for an address does not
-- break the links its owner already has.
create table waitlist_tokens (
    token_hash bytea primary key check (length(token_hash) = 32),
    email text not null references waitlist (email) on delete cascade,
    created_at timestamptz not null default now()
);

create index waitlist_tokens_email on waitlist_tokens (email, created_at);

-- Down Migration

drop table waitlist_tokens;
drop table waitlist;
