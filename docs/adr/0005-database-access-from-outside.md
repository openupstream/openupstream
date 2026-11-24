# ADR-0005: Database access from outside the cluster

Date: 2026-11-17
Status: accepted

Built on 2026-11-17 (SDK 0.5.0, `oup` 0.4.0), run end to end against
Postgres 17 and PgBouncer in Docker and then on the Hetzner dev cluster the
same day; see "Verified" for what each showed and what is still open.

## Context

A Database is reachable from inside the cluster only (decision 61). Its
Pooler has an in-cluster address, the NetworkPolicy `project-isolation`
(decision 89) admits the Project's own pods, Traefik and CloudNativePG's
operator, and the API never returns the password: the Project's Services
and Jobs get the URL in their environment (decision 97).

A Member cannot run `psql`, a migration or a database GUI from their own
machine. On AWS the same person reaches RDS at a public endpoint or through
a tunnel, so the gap shows on the first day of a migration (Open question
13).

Four ways were considered:

- **A public endpoint.** One hostname per Database on port 5432, routed by
  Traefik's TCP router on the TLS server name. Any Postgres client works,
  hosted tools included. It opens Postgres's login to the internet, needs
  the password handed out, a certificate, a second route for session
  features, and TCP bytes Traefik may not count for metering.
- **Tailscale.** Already the admin path (decision 28). For customers it
  means either their devices in our tailnet, or a proxy of ours in theirs,
  with a US company's coordination server in the path.
- **WireGuard per Project.** A user-space gateway
  ([wireproxy](https://github.com/whyvl/wireproxy)) per Project. No Postgres
  port faces the internet, but every Project needs a UDP port of its own
  open on the nodes (WireGuard has nothing like a server name to share a
  port by), and `oup`, a Node package, would have to ship a WireGuard
  binary per platform to run the client end.
- **A tunnel through the existing HTTPS port**, opened by `oup`.

Migrations are the first thing a Member needs the access for, and they ask
two things of it that reading rows does not. What a migration creates has
to belong to `app`, the role the Project's Services connect as: a table
owned by the Member's own role cannot be read by `app` or altered by
another Member, and a role that owns a table cannot be dropped when the
Member leaves. And most migration tools (Prisma, Flyway, node-pg-migrate,
Rails, golang-migrate) hold a session advisory lock while they run, which
PgBouncer in transaction mode does not carry: the lock stays on a pooled
server connection after the tool has gone, and the next run cannot take
it until PgBouncer closes that connection, which it does only once the
role has left it unused for 10 minutes.

Three ways to make a Member's role act as `app` were considered:

- **A superuser sets it.** CloudNativePG's managed roles can make a role a
  member of `app` but cannot set its default role, and CloudNativePG runs
  no SQL after a Cluster's bootstrap. It would take a Job per Database
  with superuser access in the Project's namespace, or a function
  installed at bootstrap that Databases created before it lack.
- **Default privileges** (`ALTER DEFAULT PRIVILEGES … GRANT ALL … TO
  app`). `app` could then use the Member's tables but not alter or drop
  them, so a Service that migrates at startup fails, and the role still
  owns them.
- **The role sets it itself.** Postgres lets any role set its own session
  defaults, and honors `role = app` at login only for a member of `app`.

## Decision

1. **`oup pg proxy <database>` opens the connection.** While it runs, it
   listens on a local port (5432 by default, `--port` for another; it
   stops with a message if the port is taken, as it is on a machine with
   a Postgres of its own) and carries every connection
   to the Database. The Member points any Postgres client at `localhost`.
   Nothing is installed besides `oup`, and nothing changes in the machine's
   network settings.
2. **The tunnel is a WebSocket through Traefik on port 443**, at a host
   of the Project's own under the customer domain,
   `pg-<project id>.<customer domain>`. No new port is opened on the
   nodes, and the wildcard DNS record and certificate of the default
   Domains cover the host. `oup` sends the token it uses for the API and
   learns the address from the API. No default Domain may take a name of
   that form. The platform's host keeps to the platform's namespace, and
   a Project's data stays under the customer domain, as with its Routes
   and Buckets.
3. **One forwarder pod per Project**, in the Project's namespace, created
   when the Project first needs it. It copies bytes between the WebSocket
   and a Database's Pooler or primary (point 5) and does nothing else: it
   holds no credentials and decides nothing, the target is named by the
   request Traefik let through. It runs once and is rescheduled to the
   other compute Site when its Site fails. Because it is a pod of the
   Project, `project-isolation` already lets it reach the Database and
   already lets Traefik reach it; an egress policy of its own limits it to
   the Project's Poolers, its Databases' instances on port 5432 and DNS.
4. **Traefik asks the control plane before it forwards.** A ForwardAuth
   middleware on the tunnel's route calls the control plane, which checks
   that the token belongs to a Member of the Project's Account, or is an
   API key of one. A request that fails the check never reaches the
   Project's namespace. The check happens once, when the WebSocket opens.
5. **The Pooler for `read` and `write`, the primary for `owner`.** At
   `read` and `write` the tunnel reaches a Database the way a Service
   does, through PgBouncer in transaction mode. At `owner` it reaches the
   Cluster's read-write Service, so every connection is a Postgres session
   of its own and advisory locks, `LISTEN` and session `SET` work. `oup`
   picks the target from the level. An `owner` role may hold five
   connections at a time (the role's connection limit), since each is a
   Postgres backend.
6. **Postgres roles per caller, Database and access level**, not the
   `app` password. The caller is a Member, or an API key, which gets
   roles of its own (point 8). `oup pg proxy --access read|write|owner`
   picks the level, `read` when nothing is given:
   - `read` may read every table (Postgres's `pg_read_all_data`);
   - `write` may also insert, update and delete rows
     (`pg_write_all_data` on top of `read`'s), but not change the schema;
   - `owner` acts as `app`, so it may do everything `app` may and what it
     creates belongs to `app`. Migrations need it. The role is a member
     of `app` with `app` as its default role: on every start at this
     level, before it listens, `oup` connects as the role, runs
     `ALTER ROLE CURRENT_USER SET role = 'app'` and checks on a new
     connection that it now acts as `app`. No superuser and no SQL from
     the platform is involved. Postgres still records the Member's role
     as the session's user (`pg_stat_activity`).

   A caller has at most three roles per Database, one per level. The
   first `oup pg proxy` of a caller for a Database at a level records the
   role in the control plane, which generates its password and keeps it
   encrypted, as it keeps a Project's Secrets. The control plane also
   writes the Kubernetes Secret in the Project's namespace that
   CloudNativePG reads the password from, as it writes the Project's
   other Secrets; the Databases operator adds the role to the Cluster
   and names that Secret, without seeing the password. `oup` prints the
   connection URL. The control plane returns the password on every later
   run, to the role's own caller and no one else, so the URL is the same
   on every machine and a connection saved in a client keeps working. A
   role is dropped with the Database and when the Member, or the Member
   an API key belongs to, leaves the Account. Decision 61 stands: the
   `app` password is still never returned.
7. **Every Member picks their own level.** Nothing stops a Member from
   asking for `owner`: the levels guard against mistakes, such as a
   stray `DELETE` while looking at production, not against a colleague.
   Limiting what a given Member may pick needs Member roles (Open
   question 9), which are not part of this decision.
8. **An API key gets roles of its own**, not those of the Member it
   belongs to, so a CI run and a person stay apart in Postgres. Asking
   for a role records one, so a key needs `openupstream:write` at every
   level, `read` included (decision 64): a key with only
   `openupstream:read` opens no tunnel.

## Consequences

- A Member reaches a Database from a laptop with `oup` and a Postgres
  client, and a CI run with an API key runs migrations. Who connected is
  known twice: the token at the tunnel, the role in Postgres.
- The control plane holds a readable password per role, which the
  role's own caller can ask for again: a Member gets no other Member's
  and no key's. It is also in a Secret of the Project's namespace, as
  the `app` password is. By itself it opens nothing from outside:
  Postgres is reached only through the tunnel, which wants a token.
  Inside the cluster it works from the Project's own pods alone.
- A revoked API key opens no tunnel, but madAuth does not say when a key
  is revoked, so its roles stay in the Database, unreachable from
  outside, until the Database goes or a cleanup that asks madAuth is
  built. (Since decision 143 madAuth's `user.api_key_revoked` drops them,
  ADR-0006.)
- Nothing new faces the internet. An attacker without a valid token gets
  an HTTP 401 from Traefik and no Postgres login to guess at.
- Tools that cannot run `oup` cannot connect: a hosted BI tool, another
  platform's functions. That still needs the public endpoint, which this
  decision does not rule out.
- Migrations run from a Member's machine at `owner`: what they create
  belongs to `app`, and tools that take an advisory lock work. At `read`
  and `write`, `LISTEN`, advisory locks and session `SET` do not work,
  as for a Service.
- An `owner` connection is a Postgres backend, not a pooled one, and ends
  when the primary restarts (a memory resize) or fails over; the Member
  runs the command again. Five per role keeps a few Members' sessions
  well below Postgres's 100 connections at the 256 MB floor.
- `owner` acting as `app` rests on `oup`, not on the platform: a role
  whose default was never set would create tables that `app` cannot read
  and could not be dropped. `oup` sets it before it prints the role's
  connection URL and does not listen before the check passes. A Member
  can still switch back by hand (`SET ROLE`), as they can do anything
  else at `owner`.
- `oup` gets a Postgres client of its own (the `pg` package) for that one
  statement.
- Acting as `app` includes what `app` may do to itself: a Member at
  `owner` can change `app`'s password and session defaults
  (`ALTER ROLE app …`), as a Service can today. A changed password stops
  the Project's Services from connecting, and the Member then knows it,
  which decision 61 otherwise rules out. It is of use only inside the
  Project: a Member who has left has no token for the tunnel.
- An `owner` role owns nothing, so it can be dropped when the Member
  leaves.
- Nothing stops a Member from pointing a `read` or `write` role at the
  primary with a client other than `oup`; like the levels, the targets
  guard against mistakes.
- Postgres traffic passes through Traefik, next to customers' HTTP
  traffic.
- The forwarder pod uses memory in every Project that has used the tunnel.
  Who pays for it, and whether a Hold removes it, is open.
- PgBouncer keeps a pool per role, so every `read` and `write` role can
  hold server connections of its own, at a 256 MB floor: up to two per
  Member and per API key per Database.
- Roles have no names and cannot be listed or revoked one by one. Named
  credentials, which could also serve a public endpoint or CI, would be
  a later step.
- An open tunnel outlives what authorized it: a token that expires or a
  Member who is removed keeps the connection until the WebSocket closes.
  Dropping the Member's role ends its use of the Database; a longest
  lifetime for a tunnel is open.
- A tunnel is down while the forwarder restarts or moves to the other
  Site, up to about a minute in a Site failure.
- New Kubernetes objects per Project (a Deployment, a Service, an
  IngressRoute with its middleware, a NetworkPolicy) need an operator to
  apply them and a ClusterRole that grants exactly those.

## Verified

Tried on 2026-11-17 with Postgres 17.11 and CloudNativePG's PgBouncer
image (1.24.1, transaction mode, `auth_query`) in Docker, without
CloudNativePG:

- A role created while PgBouncer runs logs in through it. A `read` role
  cannot write; a `write` role writes rows but cannot alter or create a
  table; both hold for a table created after the roles.
- A member of `app` without the default creates tables that `app` cannot
  read, another member of `app` cannot alter, and that keep the role from
  being dropped.
- The role sets `role = 'app'` for itself. Its next login acts as `app`:
  new tables belong to `app`, it alters `app`'s tables, `pg_stat_activity`
  names the Member's role, a password change keeps the setting, and the
  role drops cleanly, its setting with it. A role that is not a member of
  `app` gets a warning at login and stays itself.
- Acting as `app`, the role changed `app`'s password and `app`'s session
  defaults.

Built, and run on 2026-11-17 against the same images with the forwarder
(`operators/src/forwarder`) and `oup`'s proxy code (`cli/src/proxy.ts`)
on this machine, Traefik and the control plane left out:

- An `owner` role added four seconds after `oup` first tried to log in:
  `oup` waited, set the default and checked it. The session then acted as
  `app`; a new table belonged to `app`, which read it; an advisory lock a
  client took and left behind was free for the next one, through the
  primary. A second start left `app`'s own settings alone (`oup` sets the
  default only while the role does not act as `app` yet, since
  `ALTER ROLE CURRENT_USER` would otherwise change `app`).
- A `read` role through PgBouncer read a table made after it and could
  not insert; a wrong password was refused.
- madAuth's answer to an API key (`/auth/api-keys/verify`, 0.7.0-beta.2)
  names the key with its id, which a role per key needs.
- Through PgBouncer the setting only reaches server connections opened
  after it, and an advisory lock taken by a client that then left was
  still held by its idle server connection, so another role could not
  take it. Directly, the lock went with the session.

On the Hetzner dev cluster on 2026-11-17 (k3s 1.36.5, three Sites, the
images of the pull request's commit, Traefik 3.7 with Let's Encrypt
staging), with a user signed up through madAuth, an API key that may
write and one that may only read, and `oup pg proxy` run from this
machine:

- The tunnel's objects came with the first role: the forwarder ran under
  gVisor, CloudNativePG added the role to the running Cluster
  (`managedRolesStatus` reconciled) and its Pooler accepted it, and the
  IngressRoute at `pg-<project id>.<customer domain>` was served with the
  default wildcard certificate.
- Traefik's ForwardAuth reached the control plane and passed the upgrade
  through: 101 for the write key at the primary and for a session at the
  Pooler, 401 without a token, 403 for the read-only key, before the
  request reached the Project's namespace.
- At `owner` the session acted as `app` on the primary, not PgBouncer,
  with a password login and no TLS between forwarder and Postgres (the
  tunnel has TLS up to Traefik): a new table belonged to `app`, which read
  it, and an advisory lock left by one session was free for the next. The
  role had `app` as its only grant and the connection limit 5.
- The default role stayed after CloudNativePG's operator restarted and
  reconciled every role again, and after a third role made the instance
  manager reconcile the roles in the database.
- A `read` role, whose first start waited 14 s for the operator, read a
  table created after it and could not insert. A connection through it
  answered after 5½ minutes idle.
- Deleting the forwarder's pod ended its tunnels; new ones opened again
  after 6 s (503 meanwhile, which `oup` retries).
- Found and fixed: the first `oup pg proxy` in a Project asked before the
  operator had applied the tunnel's route, got Traefik's own 404 and took
  it for a refusal. The control plane's check now refuses with 403 only,
  and `oup` waits out a 404; in a new Project the first start then
  listened after 18 s.
- Traefik counts each tunnel as a request (status 0) with 0 bytes, so
  tunnel traffic is not metered as Egress (decision 16); the forwarder
  logs each tunnel's bytes.

Still open, outside this decision:

- Whether CloudNativePG sets `app`'s password back to its Secret's after
  a Member at `owner` changed it, and how soon.
- Tunnels open for hours (5½ minutes idle were tried), and a longest
  lifetime for one.
- Metering the tunnel's traffic, and who pays for the forwarder pod.
