import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DOCS_END, DOCS_START } from '../../../dashboard/src/lib/docs.ts';
import { cliReference } from './cli-reference.ts';

test('takes what is between the markers and puts frontmatter before it', () => {
    const page = cliReference(`# cli\n\nfor contributors\n\n${DOCS_START}\n\n- \`oup login\`: signs in.\n\n${DOCS_END}\n\n## Releasing\n`);
    assert.ok(page.ok);
    assert.match(page.value, /^---\ntitle: oup command line\n/);
    assert.ok(page.value.endsWith('---\n\n- `oup login`: signs in.\n'));
    assert.doesNotMatch(page.value, /contributors|Releasing/);
});

test('cuts the pointers to decisions, also across a line break', () => {
    const page = cliReference(`${DOCS_START}\ngrant (ARCHITECTURE.md,\n  decision 87). Nothing is kept (decision 21): gone.\n${DOCS_END}`);
    assert.ok(page.ok);
    assert.ok(page.value.endsWith('\ngrant. Nothing is kept: gone.\n'));
});

test('is an error without both markers in this order', () => {
    assert.equal(cliReference('no markers').ok, false);
    assert.equal(cliReference(`${DOCS_END}\ntext\n${DOCS_START}`).ok, false);
});

test("the CLI's README gives a page without a pointer to a decision", () => {
    const page = cliReference(readFileSync(new URL('../../../cli/README.md', import.meta.url), 'utf8'));
    assert.ok(page.ok);
    assert.match(page.value, /oup login/);
    assert.doesNotMatch(page.value, /decision \d|ARCHITECTURE\.md/);
});
