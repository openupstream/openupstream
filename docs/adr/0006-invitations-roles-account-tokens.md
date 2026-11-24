# ADR-0006: Invitations, Member roles and Account tokens

Date: 2026-11-17
Status: accepted

Designed on 2026-11-17. Built so far: the roles, listing, changing and
removing Members, leaving, and dropping a removed Member's Postgres roles
(points 1, 4 and 6, without grants and madAuth's webhooks), tested against
Postgres in Docker and run on the Hetzner dev cluster on 2026-11-17 and
18 (see `ARCHITECTURE.md`, "Control plane"). Decisions 138 to 145
in `ARCHITECTURE.md` index it. It settles Open question 9 and the
invitation part of Open question 16.

## Context

An Account has exactly one Member today: the madAuth user who created it
(`POST /v1/accounts`, decision 62). The `members` table allows more, but
nothing adds one, and every Member may do everything: `accountsOf`
(`control-plane/src/api/auth.ts`) returns the caller's Accounts, and every
route only checks that the Project is in one of them. API keys are limited
by their madAuth scopes alone, `openupstream:read` for GET and
`openupstream:write` for everything (decision 64).

Decision 126 ([ADR-0005](0005-database-access-from-outside.md)) gave each
Member and each API key Postgres roles of their own at `read`, `write` or
`owner`, and left every Member free to pick any level until there are
Member roles (Open question 9). It also left open how a Member's roles are
dropped when they leave, and the roles of a revoked API key stay until
their Database goes.

Roles only matter once an Account can have more than one Member, and an
invitation names what the invited person may do, so invitations and roles
are designed together.

Three needs came up while deciding:

- People who build (deploy Services, create Databases) and someone who
  manages who is in the Account.
- Other people, and tools, with narrow access: an analyst or a BI tool
  that may read one Database and nothing else.
- Keys for CI and tools that belong to the Account, not to a person, so
  they keep working when that person leaves, and that are limited to
  exactly what the tool needs. The cloud providers solve this with service
  accounts.

madAuth (decisions 22, 63) has no organizations and no invitations. Its
claims belong to a user across every Account and are capped at 1024
bytes, so they cannot hold a role per Account; its API keys belong to a
user and carry scopes from one fixed list per installation (at most 20 per
key), so they cannot name a single Resource. What it does offer, and this
design uses: sign-up with an e-mail link or a password, the
`user.signing_up` webhook that allows or refuses a sign-up (decision 86),
and the `user.deleted` and `user.api_key_revoked` webhooks.

How comparable platforms do it (docs read 2026-11-17):

| Platform | Roles | Narrow access | Invitations | Tokens |
| --- | --- | --- | --- | --- |
| [Vercel](https://vercel.com/docs/rbac/access-roles) | Owner, Member, Developer, Viewer, Billing | per-project roles, Enterprise only | by Owners, [expire after 7 days](https://vercel.com/docs/rbac/managing-team-members) | per user, scoped to a team or project |
| [Render](https://render.com/docs/team-members) | Admin, Developer; Viewer, Contributor, Billing on Scale | per protected environment | by Admins | per user, [capped by the user's role](https://render.com/docs/scoped-api-keys) |
| [Railway](https://docs.railway.com/projects/workspaces) | Admin, Member, Deployer | project Owner, Editor, Viewer | by Admins, also links | account, [workspace and project tokens](https://docs.railway.com/guides/public-api) |
| [Fly.io](https://docs.fly.io/security/org-roles-permissions) | Admin, Member | none | by Admins | personal, [org- and app-scoped tokens](https://docs.fly.io/security/tokens) |
| [Neon](https://neon.com/docs/manage/user-permissions) | Admin, Editor, Viewer, Collaborator | per-project grants that only add | by Admins, resend and cancel | personal keys end with the membership; [org and project keys](https://neon.com/docs/manage/api-keys) |
| [Supabase](https://supabase.com/docs/guides/platform/access-control) | Owner, Administrator, Developer, Read-Only | project-scoped roles, Team plan | expire after 24 hours | personal |
| [GitHub](https://docs.github.com/en/organizations/managing-membership-in-your-organization/inviting-users-to-join-your-organization) | Owner, Member, Billing manager, … | per repository | must match a verified address, expire after 7 days | fine-grained, may be required to expire |
| AWS ([Identity Center](https://docs.aws.amazon.com/singlesignon/latest/userguide/addusers.html)) | permission sets, no fixed roles | per account | expire after 7 days | temporary credentials; workload identity federation |

Billing is folded into the top role at Neon, Supabase, Railway and Fly.io.
Database credentials are mostly kept apart from team roles; only Neon
(Viewers see no connection strings) and Supabase (Read-Only runs `SELECT`
as a `pg_read_all_data` role) tie them together.

## Decision

### 1. Two roles, or none (decision 138)

A Member has one of two roles in an Account, or none:

- **owner**: everything a developer may, and the Account itself: who is a
  Member and with which role or grants, invitations, Account tokens, the
  payment method and invoices (in the billing service), the Account's name.
- **developer**: every Project of the Account and everything in it:
  create and delete Projects, Databases, Buckets, Services, Jobs, Domains,
  Routes and Secrets, and every database access level (point 3).
- **no role**: the Member sees and uses only what grants give them
  (point 2).

There is no billing role and no read-only role. Billing belongs to the
owners, as at Neon, Supabase, Railway and Fly.io; the internal API gives
the billing service each Member's role, so a billing role can be added
once that service has screens. Narrow access is a grant, not a role.

The creator of an Account is its first owner. Existing Members become
owners when the role is introduced. An Account always keeps at least one
owner: the last owner cannot leave, be removed or lose the role through
the API, which the schema enforces like the data model's other
invariants. The one exception is a madAuth user who is deleted (point 6).

### 2. Grants on single Resources (decision 139)

A grant gives one Member, or one Account token (point 7), access to one
Resource at a level. Databases come first, at `read`, `write` or `owner`
(decision 126's levels); Buckets, Services and Jobs can become grantable
later with levels of their own.

A grant is about using the Resource, not managing it: a grant on a
Database lets its holder see the Database and the name of its Project and
open `oup pg proxy` at the granted level or lower. It does not let them
resize or delete the Database, read the Project's Secrets, logs or usage,
or see the Project's other Resources. A Member with a role needs no
grants; a grant to them changes nothing. A grant goes with its Resource.

### 3. Database access levels (decision 140)

- owners and developers may pick any level, as today: they can delete the
  Database through the API anyway, and migrations from a laptop or CI need
  `owner`.
- a grant allows its level and those below it (`read` < `write` <
  `owner`).

The tunnel check (`GET /v1/database-tunnel`) checks the level as well as
the Account: the primary, which only `owner` reaches, needs a role or an
`owner` grant. This replaces point 7 of ADR-0005 ("every Member picks
their own level").

### 4. Personal API keys (decision 141)

A Member's madAuth API key may do what both its scopes and its Member's
role or grants allow now. Both are checked on every request, so a changed
role or a removal counts from the next request; madAuth's answer about
the key itself is still reused for a minute (decision 64).

API keys never manage the Account: inviting, revoking invitations,
changing roles and grants, removing Members and managing Account tokens
need a session or `oup`'s access token. A leaked CI key cannot let anyone
in. Leaving an Account needs a session or `oup`'s access token too;
accepting an invitation needs a session, whose address it checks.

### 5. Invitations (decision 142)

- **Only owners invite**, by e-mail address, with a role or with grants.
  An address has at most one pending invitation per Account; inviting it
  again replaces the old one. Inviting a Member is refused (409).
- **The e-mail** is sent through SES with the control plane's send-only
  key, as the waitlist's are (decision 66). It names the Account and the
  inviting owner's address and links to the dashboard,
  `https://<platform domain>/invitations#<token>`: the token stays in the
  fragment, so it reaches no server log. The token is 32 random bytes; the
  control plane keeps only its hash.
- **Accepting needs a signed-in madAuth user whose address equals the
  invited one** (ignoring case). madAuth starts a session only once the
  address is confirmed, so the address is proven; to be checked again when
  this is built, also for addresses from OpenID Connect providers. A
  forwarded or leaked e-mail lets no one else in. Someone who signs in with
  another address is invited again under that one.
- **The page only shows a button.** It names the Account, the inviting
  owner and the role or grants, and accepting or declining is a `POST`
  with the session, so a mail scanner opening the link changes nothing.
  Someone without a madAuth user signs up in madAuth's dialog with the
  invited address filled in. The dashboard does not offer to create an
  Account to someone who came with an invitation.
- **Invitations expire after 7 days**, as at Vercel, GitHub and AWS
  Identity Center. Owners see the pending ones and revoke them; resending
  makes a new token, ends the old link and starts 7 new days. An Account
  sends at most 20 invitation e-mails a day, and one address at most one
  an hour. The cleanup loop deletes accepted, declined, revoked and
  expired invitations 30 days later.
- **Grants in an invitation** name Resources of the Account. One deleted
  before the invitation is accepted is left out.
- **Closed sign-up lets invited addresses in.** With `SIGNUP=closed`
  (decision 86) the sidecar's answer to madAuth's `user.signing_up` also
  allows an address with a pending invitation, which it asks the control
  plane's internal API for. Inviting is the way into a closed installation,
  so someone who runs openupstream needs no `SIGNUP_ALLOW` list for their
  team. On the hosted service, behind the waitlist, owners can bring in
  people too.

### 6. Leaving, removing, changing roles (decision 143)

- An owner removes any Member and changes any Member's role and grants;
  every Member may leave on their own. Both are refused for the last owner
  (point 1).
- **What a Member may no longer use is taken from them at once.** Their
  Postgres roles, and those of their API keys (decision 126), on every
  Database where they lose the level, are dropped: on removal or leaving
  all of them in the Account; on a lower role or grant those above it. The
  control plane marks the role rows, deletes their Secrets, and the
  Databases operator renders them as `ensure: absent` in the Cluster's
  `managed.roles` for as long as the Database lives; the rows go with it.
  CloudNativePG leaves a role alone once it is no longer listed, so an
  entry removed before the drop happened (a Cluster that was down) would
  keep the role in Postgres for good; one entry of about 100 bytes per
  dropped role is the price. A marked row no longer counts as the
  caller's role, so a Member who gets the level back gets a new role with
  a new name (the uniqueness of a caller's role per Database and level
  holds for unmarked rows only). Their Resources stay: everything belongs to a Project, not to a
  Member.
- **madAuth tells the control plane** through the sidecar: `user.deleted`
  removes the user's Members in every Account, and
  `user.api_key_revoked` drops that key's Postgres roles, which so far
  stayed until their Database went (ADR-0005). madAuth cannot be kept from
  deleting a user, so this removal skips the last-owner rule: an Account
  whose last owner deleted their madAuth user is left without one, the
  control plane logs it as an error, and the operator of the installation
  gives it a new owner by hand.

### 7. Account tokens (decision 144)

An Account token is a named secret that belongs to the Account, not to a
person, for CI, BI tools, scripts and other platforms' functions: whatever
runs outside the platform and needs the API or a Database.

- **Rights**: either the developer role or grants (point 2), never owner,
  so a token cannot manage the Account. "metabase: `read` on Database
  `main`"; "ci: developer".
- **Not attached to anything.** Whoever holds the secret can use it,
  from anywhere its IP ranges allow. It is not an identity of the
  customer's own Services; that is a feature of its own (Open question
  19).
- **The secret** (`oup_tok_…`) is made by the control plane and shown
  once, by `oup token create` or the API, never by the dashboard, whose
  JavaScript holds no credential (decisions 127 to 129). The control plane
  keeps its hash and checks it on every request, so a revoked token stops
  at once. `oup` and the SDK send it like an API key (`OUP_API_KEY`); the
  prefix tells it apart from madAuth's `madauth_…`.
- **Expiry is required**, at most a year. The owners get an e-mail 14 days
  before.
- **Source IP ranges**, optionally: a token with them is refused from any
  other address, the tunnel check included. Most SaaS tools publish their
  egress addresses. The client's address is the one Traefik saw; the
  control plane takes it only from Traefik.
- **Rolling** replaces the secret, with a new expiry, and keeps the token:
  its name, rights and Postgres roles. The old secret keeps working for 24
  hours, so CI can be switched over. A BI tool's saved database connection
  survives a roll.
- **Postgres roles of its own**, one per Database and level, as for a
  Member (decision 126), dropped with the token or the grant.
- **Owners** create, change, roll and revoke tokens; owners and developers
  see the list (name, rights, expiry, IP ranges, last use), never a
  secret.

Account tokens do not wait for invitations: they need the roles and
grants of points 1 and 2 only.

### 8. Tokens from CI without a stored secret (decision 145)

Designed now, built after the static Account tokens. An Account token may
carry trust rules: an OIDC issuer (GitHub Actions, GitLab CI) and the
claims a run's ID token must have (repository, branch or environment). In
such a run `oup` exchanges the run's ID token for a credential of the
token's rights valid 15 minutes; nothing is stored in CI. The control
plane fetches each issuer's keys as it does madAuth's. This is how AWS and
GCP workload identity federation and npm's and PyPI's trusted publishing
work.

### What each caller may do

| Route | owner | developer | grant | personal API key | Account token |
| --- | --- | --- | --- | --- | --- |
| `GET` of Projects and Resources | all | all | the granted Resource and its Project's name | as its Member, with `openupstream:read` | as its role or grants |
| writes to Projects and Resources | all | all | none | as its Member, with `openupstream:write` | developer only |
| a Bucket's secret key | yes | yes | no | as its Member, with write | developer only |
| `oup pg proxy`, tunnel | any level | any level | up to the level | as its Member, with write | as its role or grants |
| list Members | yes | yes | themselves | as its Member | no |
| invite, revoke, change roles and grants, remove | yes | no | no | never | never |
| Account tokens: create, roll, revoke | yes | no (list only) | no | never | never |
| leave the Account | session or `oup` login | same | same | never | never |
| accept an invitation | session | | | never | never |
| create an Account | any signed-in user, who becomes its owner | | | with `openupstream:write` | never |

## Consequences

- An Account can have a team, and someone who joins can do everything a
  developer does without being able to change who else is in. An analyst
  or a tool reads one Database and nothing else.
- Every route checks a role or a grant, not only the Account. That is a
  check in every handler and a test per role; a forgotten check gives a
  developer's rights to a grant-only Member, so the checks belong in one
  place (the Project lookup) rather than in each route.
- No developer can be kept out of production: roles are Account-wide.
  Per-Project roles can be added later as grants on Projects, which only
  add.
- An accountant either is an owner or gets the invoices by e-mail.
- A leaked personal API key or Account token cannot invite anyone or
  change roles. A leaked developer token can still delete Resources;
  expiry and IP ranges bound it.
- New tables: grants, invitations, Account tokens; a role column on
  `members`; `database_roles` gets a caller kind for Account tokens and a
  mark for roles to drop.
- The sidecar calls the control plane's internal API for the first time
  (pending invitations, deleted users, revoked keys). Its Kubernetes
  ServiceAccount has to be listed for those routes, and madAuth's
  `WEBHOOK_EVENTS` must list `user.deleted` and `user.api_key_revoked`.
- madAuth's `user.deleted` arrives after the user is gone and is not
  retried: a lost webhook leaves the Member rows of a user who cannot sign
  in any more, harmless but listed.
- Dropping a role ends new logins and, through PgBouncer, the open
  `read` and `write` sessions, but not an open `owner` session: it acts
  as `app` and Postgres checks a role at login only (dev cluster,
  2026-11-17). A removal therefore deletes the database tunnel's pod in
  each Project where the Member had an `owner` role (the control plane
  may delete pods, not patch Deployments). That ends every tunnel
  there: other callers' open sessions drop once and reconnect (18 s on
  the dev cluster), and a migration running through one is aborted.
- The control plane checks an Account token's hash on every request, a
  query per call, so revoking is immediate.
- IP ranges rely on the client address reaching the control plane through
  Traefik intact, which has to be checked on the dev cluster (Traefik
  runs on hostPorts without a load balancer, decision 73).
- An invited person can sign up while the hosted service is closed. That
  is wanted, but it means every owner of the hosted service can bring in
  users before the gate before the first invoice is passed.
- Someone who runs openupstream can run it closed (`SIGNUP=closed`) and
  invite their team instead of keeping an allow-list.
- Cross-Account access (a grant to another Account's Member or token) is
  not part of this; a person can already be a Member of several Accounts
  (Open question 27).

## Implementation order

1. Roles: the role column, the last-owner rule, the role check in the
   Project lookup, listing and removing Members, leaving, changing roles,
   and dropping Postgres roles with `ensure: absent`; the madAuth webhooks.
2. Grants on Databases, with the tunnel check by level.
3. Invitations and Account tokens, in either order or side by side; each
   needs only 1 and 2.
4. Trust rules for CI (point 8).
