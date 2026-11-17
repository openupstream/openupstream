/**
 * The `oup` reference page: the part of `cli/README.md` between two marker
 * comments (ARCHITECTURE.md, decision 125), as a Markdown page of the docs,
 * so the README, npm's page, the dashboard's `/cli` page and this site
 * cannot say different things. The markers and what is cut from the text
 * are the dashboard's, so both pages take the same part of the README.
 */
import { DECISION, DOCS_END, DOCS_START, docsSection } from '../../../dashboard/src/lib/docs.ts';

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

const FRONTMATTER = `---
title: oup command line
description: Every command of oup, the openupstream command line tool.
editUrl: https://github.com/openupstream/openupstream/edit/main/cli/README.md
---
`;

/** The page's Markdown, frontmatter included; an error without both markers, in this order. */
export const cliReference = (readme: string): Result<string, string> => {
    const section = docsSection(readme);
    return section === undefined
        ? { ok: false, error: `cli/README.md needs ${DOCS_START} followed by ${DOCS_END}` }
        : { ok: true, value: `${FRONTMATTER}\n${section.replace(DECISION, '')}\n` };
};
