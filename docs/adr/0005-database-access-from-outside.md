# ADR-0005: Database access from outside the cluster

Date: 2026-11-17
Status: proposed

Proposed until a session on a dev cluster has checked the points under
"To verify". Nothing of it is built.

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
2. **The tunnel is a WebSocket through Traefik on port 443.** No new port
   is opened on the nodes. `oup` sends the token it uses for the API.
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
   that the token belongs to a Member of the Project's Account (a caller
   with an API key: see "To verify"). A request that fails the check
   never reaches the Project's namespace. The check happens once, when
   the WebSocket opens.
5. **The Pooler for `read` and `write`, the primary for `owner`.** At
   `read` and `write` the tunnel reaches a Database the way a Service
   does, through PgBouncer in transaction mode. At `owner` it reaches the
   Cluster's read-write Service, so every connection is a Postgres session
   of its own and advisory locks, `LISTEN` and session `SET` work. `oup`
   picks the target from the level. An `owner` role may hold five
   connections at a time (the role's connection limit), since each is a
   Postgres backend.
6. **Postgres roles per Member, Database and access level**, not the
   `app` password. `oup pg proxy --access read|write|owner` picks the
   level, `read` when nothing is given:
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

   A Member has at most three roles per Database, one per level. The
   first `oup pg proxy` of a Member for a Database at a level records the
   role in the control plane; the Databases operator adds it to the
   Cluster with a generated password, and `oup` prints the connection
   URL. A role is dropped with the Database and when the Member leaves
   the Account. Decision 61 stands: the `app` password is still never
   returned.
7. **Every Member picks their own level.** Nothing stops a Member from
   asking for `owner`: the levels guard against mistakes, such as a
   stray `DELETE` while looking at production, not against a colleague.
   Limiting what a given Member may pick needs Member roles (Open
   question 9), which are not part of this decision.

## Consequences

- A Member reaches a Database from a laptop with `oup` and a Postgres
  client. Who connected is known twice: the token at the tunnel, the role
  in Postgres.
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
  Member per Database.
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

## To verify

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
- Through PgBouncer the setting only reaches server connections opened
  after it, and an advisory lock taken by a client that then left was
  still held by its idle server connection, so another role could not
  take it. Directly, the lock went with the session.

To settle before this is accepted, on a dev cluster where it can be tried:

- CloudNativePG adds a role to a running Cluster and its Pooler accepts
  it; reconciling the role leaves its default role alone, and the
  connection limit holds.
- The primary accepts the forwarder's password login on the read-write
  Service (CloudNativePG's `pg_hba`), with TLS as a Service's connection
  has it.
- Whether CloudNativePG sets `app`'s password back to its Secret's after
  a Member at `owner` changed it, and how soon.
- Which hostname the tunnel's route lives on: the API's or one per
  Project. Traefik does not route across namespaces.
- Traefik keeps a WebSocket open for hours, and whether its bytes are
  counted as Egress like HTTP responses (decision 16).
- The forwarder runs under the `gvisor` RuntimeClass.
- How `oup` gets the role's password on a later run. Returning it every
  time means the control plane keeps it readable; setting a new one per
  run breaks a second `oup pg proxy` that is still open; keeping it in
  `oup`'s credentials file ties it to one machine.
- What a caller with an API key instead of a Member's sign-in gets (a CI
  run with `OUP_API_KEY`): a role per key, or no tunnel.
