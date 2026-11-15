import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectNameProblem, projectsByAccount } from './projects';

test('a Project name is a DNS label that the Account does not have yet', () => {
    assert.equal(projectNameProblem('staging', [{ name: 'production' }]), undefined);
    assert.match(projectNameProblem('Staging', []) ?? '', /Lowercase/);
    assert.match(projectNameProblem('-x', []) ?? '', /Lowercase/);
    assert.match(projectNameProblem('1st', []) ?? '', /Lowercase/);
    assert.match(projectNameProblem('', []) ?? '', /Lowercase/);
    assert.equal(projectNameProblem('production', [{ name: 'production' }]), 'A Project named production exists.');
});

test('Projects are listed under their Account, by name; an Account without Projects stays', () => {
    const account = (id: string) => ({ id, name: id, createdAt: '2026-11-15T00:00:00Z', holds: [] });
    const project = (accountId: string, name: string) => ({ id: `${accountId}-${name}`, accountId, name, createdAt: '2026-11-15T00:00:00Z' });
    const grouped = projectsByAccount([account('a'), account('b')], [project('a', 'staging'), project('a', 'production')]);
    assert.deepEqual(
        grouped.map((group) => [group.account.id, group.projects.map((p) => p.name)]),
        [
            ['a', ['production', 'staging']],
            ['b', []],
        ],
    );
});
