/**
 * The `oup` reference page: the part of `cli/README.md` between two marker
 * comments (ARCHITECTURE.md, decision 125), as a Markdown page of the docs,
 * so the README, npm's page, the dashboard's `/cli` page and this site
 * cannot say different things.
 */

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const DOCS_START = '<!-- docs:start -->';
export const DOCS_END = '<!-- docs:end -->';

/** Pointers into the design docs, which a reader of the site does not have. */
const DECISION = /\s*\((?:ARCHITECTURE\.md,\s+)?decision\s+\d+\)/g;

const FRONTMATTER = `---
title: oup command line
description: Every command of oup, the openupstream command line tool.
editUrl: https://github.com/openupstream/openupstream/edit/main/cli/README.md
---
`;

/** The page's Markdown, frontmatter included; an error without both markers, in this order. */
export const cliReference = (readme: string): Result<string, string> => {
    const start = readme.indexOf(DOCS_START);
    const end = readme.indexOf(DOCS_END);
    if (start === -1 || end < start) {
        return { ok: false, error: `cli/README.md needs ${DOCS_START} followed by ${DOCS_END}` };
    }
    const section = readme
        .slice(start + DOCS_START.length, end)
        .replace(DECISION, '')
        .trim();
    return { ok: true, value: `${FRONTMATTER}\n${section}\n` };
};
