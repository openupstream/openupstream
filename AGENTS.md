# AGENTS.md

Guidance for agents working in this repository. Human contributors: see
CONTRIBUTING.md.

## Design docs are canonical

- `ARCHITECTURE.md` and `docs/scope.md` are the source of truth for the v1
  design. Any change to the design updates them in the same commit. Never
  leave a decision recorded only in an ADR, an issue or a chat.
- The "Decisions" table in `ARCHITECTURE.md` is the index of all decisions.
  Every new decision gets a row there, whether or not it also gets an ADR.
- Open questions that are not decided yet are written down as open questions
  in `ARCHITECTURE.md`, not as decisions.

## Decision records (ADRs)

- Live in `docs/adr/`, named `NNNN-slug.md`, numbered sequentially from the
  highest existing number.
- Use the template in `docs/adr/README.md` (Date, Status, Context, Decision,
  Consequences). Never delete an ADR; a superseded one gets
  `Status: superseded by ADR-NNNN`.
- Write an ADR when the reasoning no longer fits in one row of the table.

## Glossary

`GLOSSARY.md` at the repository root holds the domain language (account,
tenant, routing table, …). Terms only, no implementation details. Use these
terms consistently in code, docs and issues.

## Working conventions

- Node 22, npm workspaces: `npm install`, `npm run build`, `npm run
  typecheck`, `npm test`.
- Commit messages: imperative, summary under 72 characters.
- The GitHub repository is public. Issues, PRs and comments are visible to
  everyone; do not create them without the maintainer's go-ahead.
- After completing a task, recommend one concrete next step, usually the
  next item in the build order in `ARCHITECTURE.md` or a follow-up the task
  turned up.
