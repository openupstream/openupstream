-- Up Migration

-- The version of a Project's Secrets that is in its Kubernetes Secret
-- project-secrets: set by the control plane after it wrote them
-- (src/secrets/render.ts), handed to the Services operator, which rolls
-- the Project's Services when it changes. Taken from what was written, not
-- from the rows, so pods never restart before the new values are there.
alter table projects add column secrets_version text;

-- Down Migration

alter table projects drop column secrets_version;
