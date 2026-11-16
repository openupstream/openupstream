import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { apiOf, docsProblems, docsSection, parseDocs, withApi } from './docs';

const readme = readFileSync(new URL('../../../cli/README.md', import.meta.url), 'utf8');

test('the part between the markers, and nothing without both', () => {
    assert.equal(docsSection('# cli\n<!-- docs:start -->\n\nthe text\n\n<!-- docs:end -->\n## Releasing'), 'the text');
    assert.equal(docsSection('# cli\nthe text'), undefined);
    assert.equal(docsSection('<!-- docs:end -->\nthe text\n<!-- docs:start -->'), undefined);
});

test('paragraphs, list items over several lines, code blocks and inline code', () => {
    const text = ['```sh', 'oup login', 'oup pg create main', '```', '', '- `oup login [--api <url>]`: signs', '  in (ARCHITECTURE.md, decision 87).', '- `oup logout`', '', 'In CI, set', '`OUP_API_KEY` (decision 21): done.'].join('\n');
    assert.deepEqual(parseDocs(text), [
        { kind: 'code', text: 'oup login\noup pg create main' },
        {
            kind: 'list',
            items: [
                [
                    { code: true, text: 'oup login [--api <url>]' },
                    { code: false, text: ': signs in.' },
                ],
                [{ code: true, text: 'oup logout' }],
            ],
        },
        {
            kind: 'paragraph',
            text: [
                { code: false, text: 'In CI, set ' },
                { code: true, text: 'OUP_API_KEY' },
                { code: false, text: ': done.' },
            ],
        },
    ]);
});

test('what the page cannot show is named', () => {
    assert.deepEqual(docsProblems('a `b` c\n\n```sh\n# a comment, **not bold**\n```'), []);
    assert.deepEqual(docsProblems('## More\nsee [here](x), **now**\n- a\n  - b\n1. one\n`open'), ['a heading', 'a link', 'bold text', 'a list inside a list', 'a numbered list', 'an unclosed `']);
    assert.deepEqual(docsProblems('```sh\noup login'), ['an unclosed code block']);
});

test("another installation's address goes into the example's oup login", () => {
    const blocks = parseDocs('```sh\nnpm i -g @openupstream/cli\noup login\noup logout\n```\n\nRun `oup login`.');
    const api = apiOf('https://cloud.example');
    assert.equal(api, 'https://cloud.example/api');
    assert.equal(withApi(blocks, api, api), blocks);
    assert.deepEqual(withApi(blocks, api, 'https://console.openupstream.com/api'), [
        { kind: 'code', text: 'npm i -g @openupstream/cli\noup login --api https://cloud.example/api\noup logout' },
        blocks[1],
    ]);
});

test("the CLI's README has a part for the page, which the page can show whole", () => {
    const section = docsSection(readme);
    assert.ok(section !== undefined);
    assert.deepEqual(docsProblems(section), []);
    const blocks = parseDocs(section);
    assert.equal(blocks[0]?.kind, 'code');
    assert.ok(blocks[0]?.kind === 'code' && blocks[0].text.split('\n').includes('oup login'));
    assert.ok(blocks.some((block) => block.kind === 'list' && block.items.length > 10));
    assert.ok(!JSON.stringify(blocks).includes('decision'));
});
