import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Member } from '@openupstream/sdk';
import { formatMembers, memberByEmail, parseGrantAccess, parseRole } from './members.js';

const member = (email: string, role: Member['role']): Member => ({
    id: `id-${email}`,
    accountId: 'a',
    authSubject: `usr_${email}`,
    email,
    role,
    grants: [],
    createdAt: '2026-11-17T10:00:00.000Z',
});
const members = [member('olga@example.test', 'owner'), member('Dev@Example.test', 'developer'), member('analyst@example.test', null)];

test('one line per Member with address, role (- without one) and since when', () => {
    const lines = formatMembers(members);
    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? '', /^olga@example\.test\s+owner\s+since 2026-11-17$/);
    assert.match(lines[2] ?? '', /^analyst@example\.test\s+-\s+since 2026-11-17$/);
});

test('a Member is found by address, ignoring case; an unknown one is an error', () => {
    const found = memberByEmail(members, 'dev@example.TEST');
    assert.ok(found.ok);
    assert.equal(found.value.id, 'id-Dev@Example.test');
    assert.deepEqual(memberByEmail(members, 'nobody@example.test'), { ok: false, error: 'no Member nobody@example.test in this Account' });
});

test('the role is owner, developer or none, which leaves only the grants', () => {
    assert.deepEqual(parseRole('owner'), { ok: true, value: 'owner' });
    assert.deepEqual(parseRole('developer'), { ok: true, value: 'developer' });
    assert.deepEqual(parseRole('none'), { ok: true, value: null });
    assert.deepEqual(parseRole('admin'), { ok: false, error: 'the role must be one of owner, developer, none' });
    assert.equal(parseRole(undefined).ok, false);
});

test("a Member's grants follow their line as project/database:level", () => {
    const analyst: Member = {
        ...member('analyst@example.test', null),
        grants: [
            { databaseId: 'd1', databaseName: 'orders', projectId: 'p1', projectName: 'shop', access: 'read', createdAt: '2026-11-27T10:00:00.000Z' },
            { databaseId: 'd2', databaseName: 'events', projectId: 'p1', projectName: 'shop', access: 'owner', createdAt: '2026-11-27T11:00:00.000Z' },
        ],
    };
    assert.match(formatMembers([analyst])[0] ?? '', /^analyst@example\.test\s+-\s+since 2026-11-17  shop\/orders:read, shop\/events:owner$/);
});

test('a grant is read, write or owner', () => {
    assert.deepEqual(parseGrantAccess('write'), { ok: true, value: 'write' });
    assert.deepEqual(parseGrantAccess('admin'), { ok: false, error: 'the level must be one of read, write, owner' });
    assert.equal(parseGrantAccess(undefined).ok, false);
});
