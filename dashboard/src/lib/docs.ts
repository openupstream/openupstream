/**
 * The `oup` page's text: the part of `cli/README.md` between two marker
 * comments, read when the dashboard is built, so the page and the README
 * cannot say different things. Only what that part uses is understood:
 * paragraphs, one level of list items, fenced code and inline code.
 */

export interface Inline {
    readonly code: boolean;
    readonly text: string;
}

export type Block =
    | { readonly kind: 'code'; readonly text: string }
    | { readonly kind: 'list'; readonly items: readonly (readonly Inline[])[] }
    | { readonly kind: 'paragraph'; readonly text: readonly Inline[] };

export const DOCS_START = '<!-- docs:start -->';
export const DOCS_END = '<!-- docs:end -->';

/** What is between the markers; undefined without both, in this order. */
export const docsSection = (readme: string): string | undefined => {
    const start = readme.indexOf(DOCS_START);
    const end = readme.indexOf(DOCS_END);
    return start === -1 || end < start ? undefined : readme.slice(start + DOCS_START.length, end).trim();
};

/** Pointers into the design docs, which a reader of the page does not have. */
const DECISION = /\s*\((?:ARCHITECTURE\.md, )?decision \d+\)/g;

/** Text and `code` in turns; a line break inside either is a space. */
const inline = (text: string): Inline[] =>
    text
        .replace(/\s+/g, ' ')
        .replace(DECISION, '')
        .trim()
        .split('`')
        .map((part, index) => ({ code: index % 2 === 1, text: part }))
        .filter((part) => part.text !== '');

/** What the page cannot show: `docsProblems` is empty for a text `parseDocs` renders whole. */
export const docsProblems = (text: string): string[] => {
    if ((text.match(/^```/gm) ?? []).length % 2 === 1) {
        return ['an unclosed code block'];
    }
    const outside = text.replace(/```[\s\S]*?```/g, '');
    const plain = outside.replace(/`[^`]*`/g, '');
    return [
        ...(/[*_]/.test(plain.replace(/\*\*|__/g, '')) ? ['emphasis'] : []),
        ...(/^[ \t]*>/m.test(plain) ? ['a quote'] : []),
        ...(/^[ \t]*\|/m.test(plain) ? ['a table'] : []),
        ...(/^#/m.test(outside) ? ['a heading'] : []),
        ...(/\]\(/.test(outside) ? ['a link'] : []),
        ...(/\*\*|__/.test(outside) ? ['bold text'] : []),
        ...(/^[ \t]+[-*] /m.test(outside) ? ['a list inside a list'] : []),
        ...(/^\d+\. /m.test(outside) ? ['a numbered list'] : []),
        ...((outside.match(/`/g) ?? []).length % 2 === 1 ? ['an unclosed `'] : []),
    ];
};

export const parseDocs = (text: string): Block[] => {
    interface State {
        readonly blocks: readonly Block[];
        /** The lines of the block being read. */
        readonly open: { readonly kind: 'code' | 'list' | 'paragraph'; readonly lines: readonly string[] } | undefined;
    }
    const close = ({ blocks, open }: State): readonly Block[] => {
        if (open === undefined) {
            return blocks;
        }
        if (open.kind === 'code') {
            return [...blocks, { kind: 'code', text: open.lines.join('\n') }];
        }
        if (open.kind === 'paragraph') {
            return [...blocks, { kind: 'paragraph', text: inline(open.lines.join(' ')) }];
        }
        // A line that starts with "- " starts an item; the others go on with the one before.
        const items = open.lines.reduce<string[]>(
            (list, line) => (line.startsWith('- ') ? [...list, line.slice(2)] : [...list.slice(0, -1), `${list.at(-1) ?? ''} ${line}`]),
            [],
        );
        return [...blocks, { kind: 'list', items: items.map(inline) }];
    };
    const end = text.split('\n').reduce<State>(
        (state, line) => {
            const { open } = state;
            if (open?.kind === 'code') {
                return line.startsWith('```') ? { blocks: close(state), open: undefined } : { blocks: state.blocks, open: { kind: 'code', lines: [...open.lines, line] } };
            }
            if (line.startsWith('```')) {
                return { blocks: close(state), open: { kind: 'code', lines: [] } };
            }
            if (line.trim() === '') {
                return { blocks: close(state), open: undefined };
            }
            if (line.startsWith('- ')) {
                return open?.kind === 'list' ? { blocks: state.blocks, open: { kind: 'list', lines: [...open.lines, line] } } : { blocks: close(state), open: { kind: 'list', lines: [line] } };
            }
            return open === undefined ? { blocks: state.blocks, open: { kind: 'paragraph', lines: [line] } } : { blocks: state.blocks, open: { kind: open.kind, lines: [...open.lines, line] } };
        },
        { blocks: [], open: undefined },
    );
    return [...close(end)];
};

/** The API of the installation that serves the page. */
export const apiOf = (origin: string): string => `${origin}/api`;

/**
 * The example's `oup login` with this installation's address, where it is
 * not the one `oup` signs in to by default.
 */
export const withApi = (blocks: readonly Block[], api: string, defaultApi: string): readonly Block[] =>
    api === defaultApi
        ? blocks
        : blocks.map((block) =>
              block.kind === 'code'
                  ? {
                        kind: 'code',
                        text: block.text
                            .split('\n')
                            .map((line) => (line === 'oup login' ? `oup login --api ${api}` : line))
                            .join('\n'),
                    }
                  : block,
          );

/** `>=24` as "24 or newer"; any other range as it is written. */
export const nodeVersion = (range: string): string => {
    const least = /^>=\s*(\d+(?:\.\d+)*)$/.exec(range.trim());
    return least === null ? range : `${least[1]} or newer`;
};
