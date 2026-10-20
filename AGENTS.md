# AGENTS.md

Guidance for agents working in this repository. Human contributors: see
CONTRIBUTING.md. The repository layout is in README.md.

## Communication

- Keep responses concise and technical — avoid filler, hedging, and restating
  what the user already knows.
- When a change can reasonably be implemented in more than one way, ask the
  user which approach they prefer before writing code.
- Ask clarifying questions whenever requirements, scope, or expected behavior
  are ambiguous — don't guess silently.
- After completing a task, recommend one concrete next step, usually the next
  item in the build order in `ARCHITECTURE.md` or a follow-up the task turned
  up.

## Design docs are canonical

- `ARCHITECTURE.md` and `docs/scope.md` are the source of truth for the v1
  design. Any change to the design updates them in the same commit. Never
  leave a decision recorded only in an ADR, an issue or a chat.
- **Before finishing any task, re-read the sections of `ARCHITECTURE.md`,
  `docs/scope.md` and the READMEs that touch the change and update them.** A
  change without a matching docs update is incomplete work. Never leave the
  docs describing behavior that no longer exists.
- The "Decisions" table in `ARCHITECTURE.md` is the index of all decisions.
  Every new decision gets a row there, whether or not it also gets an ADR; a
  row with an ADR links to it.
- Questions that are not decided yet go in the "Open questions" section of
  `ARCHITECTURE.md`, not in the Decisions table.
- If a change contradicts an existing decision, say so explicitly instead of
  silently overriding it.

## Decision records (ADRs)

- Live in `docs/adr/`, named `NNNN-slug.md`, numbered sequentially from the
  highest existing number.
- Use the template in `docs/adr/README.md` (Date, Status, Context, Decision,
  Consequences). Never delete an ADR; a superseded one gets
  `Status: superseded by ADR-NNNN`.
- Write an ADR when the reasoning no longer fits in one row of the table.

## Glossary

`GLOSSARY.md` at the repository root holds the domain language (account,
project, routing table, …). Terms only, no implementation details. Use these
terms consistently in code, docs and issues.

## Workflow

- **When asked to implement a GitHub issue, always create a separate branch
  first** (e.g. `issue-<number>-short-description`) and do the work there —
  never commit the implementation directly to `main`.
- **Avoid stacking when possible — base every PR on `main`.** Only genuinely
  dependent changes need stacking. (Stacked PRs combined with squash merges
  force rebases and force-pushes of the child branches; for a dependent
  sequence, prefer merging each PR before starting the next one on fresh
  `main`.)
- **Every completed change — not just GitHub issues — ends with a pull request
  that is then reviewed.** Once the change is done: push the branch
  (`git push -u`), open a PR with `gh pr create`, then run the code review as
  described below. Reference the issue it implements in the PR description,
  if any.
- **Make GitHub close the issue automatically when the PR merges:** include a
  closing keyword — `Fixes #<issue>`, `Closes #<issue>` or
  `Resolves #<issue>` — in **both** the PR description and the commit
  message. Plain references like "see #10" do **not** auto-close.
- **Check for merge conflicts with `main` and fix them without being asked.**
  Before opening a PR, and again whenever you return to an open one, run
  `git fetch origin` and check the branch merges cleanly
  (`gh pr view <PR#> --json mergeable`, or attempt `git merge origin/main`).
  On a conflict, merge `origin/main` into the branch and resolve it — adopt
  the conventions `main` introduced in the meantime, don't just splice the
  textual halves together. Re-run the checks after the merge, then push.
- **Then review the pull request as a real GitHub code review**, not just a
  summary comment. In Claude Code run `/code-review medium --comment`, which
  posts each finding as an inline review comment anchored to the exact file
  and line; other agents post the same kind of review with
  `gh api repos/openupstream/openupstream/pulls/<PR#>/reviews`.
  Address any findings before considering the work done.
  - **Keep review feedback concise:** one sentence per finding — state the
    problem and its impact, no preamble. Only report real issues; no "looks
    good" filler comments.
  - **Always at least `medium`.** Use `high` (up to `max`) only when broad
    coverage matters more than noise. Do not use `low` — it misses too much
    for reviews that gate merging.
- **The repository is public.** PRs and review comments from this workflow
  are expected; create issues, or comment anywhere else, only with the
  maintainer's go-ahead.
- **After implementing a change, run what you changed and check that it works
  without errors.** Exercise the changed flow (API call, CLI command, page),
  and watch the server log and the browser console — don't just check that
  the processes start.
  - **Stop the dev servers when you are done testing**, so the ports are free
    for the next agent session.
  - **If a port is already in use, do not kill the occupying process on your
    own** — it may belong to another still-running agent session. Ask the
    user first.
- **Check for missing Kubernetes permissions.** Locally you run with an admin
  kubeconfig, which is broader than the ServiceAccounts the control plane and
  operators run as in the cluster — a call that works locally can still fail
  with `Forbidden` when deployed. For every new or changed Kubernetes object
  the control plane or an operator reads or writes, verify that its Role or
  ClusterRole grants it.

## Work outside the repository

Cloud consoles, DNS, accounts, credentials, CLI calls against live
services: anything that changes the world outside this repository. A
throwaway dev cluster (`infra/dev-cluster`) is the exception: once the
maintainer has agreed to a test session, create it, run the tests on it and
destroy it without asking per command.

- **You can do it** (a CLI or API call with access already on the
  machine): say in one or two sentences what you will run and what it
  changes, then ask the maintainer for the go-ahead before running it.
- **The maintainer does it**: creating identities, users, accounts or
  credentials, accepting terms, anything that handles a secret. Give the
  exact commands to paste in the same message, without being asked. Pipe a
  secret straight into where it is kept (a CLI profile, a file with
  `chmod 600`), so it never shows on screen or passes through the agent.
- **A setting in a web console** (bunny.net, the domain registrar, Hetzner,
  AWS): offer to make the change by driving the maintainer's browser (in
  Claude Code: Claude in Chrome) and wait for the yes. What the previous
  rule reserves for the maintainer stays with them, as click-by-click
  steps.
- Afterwards, check the result yourself with a read-only call (`dig`, a
  `get` or `list` command) and record setup that others will repeat in
  `docs/self-hosting.md`.

## Coding guidelines

- Prefer immutable variables and pure functions.
- Prefer a result type with a success and an error case over exceptions.
- Avoid try-catch blocks for branching. Prefer to check whether something
  exists over handling exceptions.
- GitHub Actions: pin every action to a full commit SHA, with its version
  in a comment (`uses: actions/checkout@<sha> # v4.4.0`).

## Testing

Before considering a task done, run what CI runs at the repo root (Node 22,
npm workspaces): `npm run build`, `npm run typecheck` and `npm test`. Every
change that alters behavior comes with a test.

## Commits

- Imperative mood, summary under 72 characters, body if the why is not
  obvious from the diff.
- Do not amend commits; create a new commit instead.
