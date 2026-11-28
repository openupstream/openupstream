-- Up Migration

-- The Sites are what the nodes' labels say (ARCHITECTURE.md, decision 150;
-- docs/adr/0007-sites-from-node-labels.md): a home_site is any Kubernetes
-- label value, checked against the compute Sites by the API, and a Database
-- created without one gets the default Site from the API, not from a column
-- default.
alter table databases drop constraint databases_home_site_check;
alter table databases alter column home_site drop default;
alter table services drop constraint services_home_site_check;
alter table jobs drop constraint jobs_home_site_check;

alter table databases add constraint databases_home_site_check
    check (home_site ~ '^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$');
alter table services add constraint services_home_site_check
    check (home_site ~ '^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$');
alter table jobs add constraint jobs_home_site_check
    check (home_site ~ '^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$');

-- Down Migration

-- The two Sites the code knew before; not valid, so rows naming another
-- Site stay, and only new or changed rows are held to them.
alter table databases drop constraint databases_home_site_check;
alter table services drop constraint services_home_site_check;
alter table jobs drop constraint jobs_home_site_check;
alter table databases add constraint databases_home_site_check check (home_site in ('hetzner-fsn1', 'ovh-lim')) not valid;
alter table databases alter column home_site set default 'hetzner-fsn1';
alter table services add constraint services_home_site_check check (home_site in ('hetzner-fsn1', 'ovh-lim')) not valid;
alter table jobs add constraint jobs_home_site_check check (home_site in ('hetzner-fsn1', 'ovh-lim')) not valid;
