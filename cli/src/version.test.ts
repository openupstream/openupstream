import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLI_VERSION } from './version.js';

test('CLI_VERSION is the version in package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(CLI_VERSION, pkg.version);
});
