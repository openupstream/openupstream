# website

The public website for `openupstream.com` (ARCHITECTURE.md, decision 130):

- a page per product, saying what it is and what to know before choosing
  it: `/postgres`, `/object-storage`, `/static-sites`, `/containers`
- the documentation under `/docs`, saying how to use it

Built with [Astro Starlight](https://starlight.astro.build) from the
Markdown files in `src/content/docs`. The file's path is the page's
address: `src/content/docs/docs/databases.md` is `/docs/databases/`.

The workflow `.github/workflows/website.yml` deploys it with
`oup site deploy` on every merge to main that changes it (decision 132;
docs/self-hosting.md, "The website"). `/waitlist`, `/privacy` and
`/imprint` are not pages of this site: the control plane serves them on
the same host while sign-up is closed, and the home page and the sidebar
link to them. When sign-up opens they go, so the links have to change and
the site needs an Impressum and a privacy notice of its own.

## Writing

- Plain Markdown (`.md`) with YAML frontmatter; `title` and `description`
  are required by convention. The build fails on frontmatter that does not
  fit the schema (no `title`, a value of the wrong kind); a key the schema
  does not know is ignored, so check the spelling of optional ones.
- Use the terms of `GLOSSARY.md`. Product pages speak to someone deciding,
  the docs to someone already using the product; neither points into
  `ARCHITECTURE.md`, which a reader of the site does not have.
- Link to other pages by their address with a trailing slash
  (`/docs/databases/`); the build fails on a link to a page or heading
  that does not exist.
- A new page gets an entry in `sidebar` in `astro.config.ts`.
- When a product changes, change its pages here with `docs/scope.md` and
  `ARCHITECTURE.md`.

`src/content/docs/docs/reference/cli.md` is not checked in:
`astro.config.ts` writes it from the part of `cli/README.md` between its
two `docs` comments (`src/lib/cli-reference.ts`), which the dashboard's
`/cli` page shows too (decision 125). Change `oup`'s reference there.

## Running it

```sh
npm run dev -w website      # http://localhost:4321
npm run build -w website    # static files in website/dist
```

The build also writes the search index (Pagefind) and `llms.txt`,
`llms-full.txt` and `llms-small.txt` for agents.
