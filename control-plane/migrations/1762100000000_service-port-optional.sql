-- Up Migration

-- A Service without a port is a worker (ARCHITECTURE.md, decision 98): it
-- gets no Kubernetes Service and no readiness probe, and no Route may serve
-- it. Route creation checks the port under a share lock on the Service; this
-- trigger refuses removing the port of a Service that a Route serves.
alter table services alter column port drop not null;

create function services_routed_keep_port() returns trigger language plpgsql as $$
begin
    if new.port is null and exists (select 1 from routes where service_id = new.id) then
        raise exception 'a Route serves service %', new.id using errcode = 'OURTD';
    end if;
    return new;
end
$$;

create trigger services_routed_keep_port before update of port on services
    for each row execute function services_routed_keep_port();

-- Down Migration

drop trigger services_routed_keep_port on services;
drop function services_routed_keep_port();
-- Fails while a Service has no port: give each one a port or delete it first.
alter table services alter column port set not null;
