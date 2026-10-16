# Contributing

Thanks for your interest. openupstream is early and the design is still
moving, so the most useful contributions right now are issues that point out
mistakes in `ARCHITECTURE.md` and `docs/`, and small, focused pull requests.

## Ground rules

- Open an issue before a large change so the design can be discussed first.
- Keep pull requests to one topic. Several small PRs are easier to review than
  one large one.
- Every change that alters behaviour comes with a test.
- Changes to architecture update `ARCHITECTURE.md` (including a row in its
  Decisions table) in the same PR, plus a record under `docs/adr/` when the
  reasoning does not fit in one row.
- By contributing you agree that your contribution is licensed under the
  AGPL-3.0-only, like the rest of the project.

## Development setup

```sh
nvm use
npm install
npm run build
npm test
```

## Commit messages

Imperative mood, one line summary under 72 characters, body if the why is not
obvious from the diff. Reference issues as `#123`.
