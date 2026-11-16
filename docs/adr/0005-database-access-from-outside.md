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
   and a Pooler and does nothing else: it holds no credentials and decides
   nothing. It runs once and is rescheduled to the other compute Site when
   its Site fails. Because it is a pod of the Project, `project-isolation`
   already lets it reach the Pooler and already lets Traefik reach it; an
   egress policy of its own limits it to the Project's Poolers and DNS.
4. **Traefik asks the control plane before it forwards.** A ForwardAuth
   middleware on the tunnel's route calls the control plane, which checks
   that the token belongs to a Member of the Project's Account (a caller
   with an API key: see "To verify"). A request that fails the check
   never reaches the Project's namespace. The check happens once, when
   the WebSocket opens.
5. **Poolers only.** The tunnel reaches a Database the way a Service does,
   through PgBouncer in transaction mode.
6. **Postgres roles per Member, Database and access level**, not the
   `app` password. `oup pg proxy --access read|write|owner` picks the
   level, `read` when nothing is given:
   - `read` may read every table (Postgres's `pg_read_all_data`);
   - `write` may also insert, update and delete rows
     (`pg_write_all_data`), but not change the schema;
   - `owner` acts as `app`, so it may do everything `app` may and what it
     creates belongs to `app`. Migrations need it.

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
- `LISTEN`, advisory locks and session `SET` do not work through the
  tunnel, which rules out migration tools that take an advisory lock. A
  direct target would fix that at the cost of Postgres's own connections.
- Postgres traffic passes through Traefik, next to customers' HTTP
  traffic.
- The forwarder pod uses memory in every Project that has used the tunnel.
  Who pays for it, and whether a Hold removes it, is open.
- PgBouncer keeps a pool per role, so every role can hold server
  connections of its own, at a 256 MB floor: up to three per Member per
  Database.
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

To settle before this is accepted, on a dev cluster where it can be tried:

- PgBouncer accepts a role added to the Cluster after it was created, and
  an `owner` role can be made to act as `app` in transaction mode. A
  `read` role cannot write and a `write` role cannot change the schema,
  also for tables created after the role.
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
