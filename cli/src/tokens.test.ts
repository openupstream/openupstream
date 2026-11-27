import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountToken } from '@openupstream/sdk';
import { formatTokens, parseExpiry, parseTokenRole, tokenByName } from './tokens.js';

const now = new Date('2026-11-27T12:00:00.000Z');
const token = (name: string, role: AccountToken['role'], expiresAt: string, lastUsedAt: string | null = null): AccountToken => ({
    id: `id-${name}`,
    accountId: 'a',
    name,
    role,
    grants: [],
    expiresAt,
    lastUsedAt,
    createdAt: '2026-11-01T10:00:00.000Z',
});

test('one line per token with role, expiry, last use and grants', () => {
    const lines = formatTokens(
        [
            token('ci', 'developer', '2027-02-25T12:00:00.000Z', '2026-11-26T08:00:00.000Z'),
            {
                ...token('metabase', null, '2026-11-20T00:00:00.000Z'),
                grants: [{ databaseId: 'd', databaseName: 'orders', projectId: 'p', projectName: 'shop', access: 'read', createdAt: '2026-11-02T00:00:00.000Z' }],
            },
        ],
        now,
    );
    assert.match(lines[0] ?? '', /^ci\s+developer\s+until 2027-02-25\s+used 2026-11-26$/);
    assert.match(lines[1] ?? '', /^metabase\s+-\s+expired 2026-11-20\s+never used  shop\/orders:read$/);
});

test('a token is found by name; an unknown one is an error', () => {
    assert.equal(tokenByName([token('ci', null, now.toISOString())], 'ci').ok, true);
    assert.deepEqual(tokenByName([], 'bi'), { ok: false, error: 'no Account token bi in this Account' });
});

test('a role is developer or none, never owner', () => {
    assert.deepEqual(parseTokenRole('developer'), { ok: true, value: 'developer' });
    assert.deepEqual(parseTokenRole('none'), { ok: true, value: null });
    assert.equal(parseTokenRole('owner').ok, false);
});

test('an expiry is days, a date or a time, in the future and at most a year away', () => {
    const errorOf = (value: string | undefined) => {
        const parsed = parseExpiry(value, now);
        return parsed.ok ? 'accepted' : parsed.error;
    };
    assert.deepEqual(parseExpiry('90d', now), { ok: true, value: new Date('2027-02-25T12:00:00.000Z') });
    assert.deepEqual(parseExpiry('2027-03-01', now), { ok: true, value: new Date('2027-03-01T00:00:00.000Z') });
    assert.deepEqual(parseExpiry('2026-12-01T08:00:00+01:00', now), { ok: true, value: new Date('2026-12-01T07:00:00.000Z') });
    assert.equal(errorOf('365d'), 'accepted');
    assert.match(errorOf('366d'), /more than 365 days away/);
    assert.match(errorOf('2026-11-01'), /not in the future/);
    assert.match(errorOf('0d'), /not in the future/);
    assert.match(errorOf('soon'), /a number of days/);
    assert.match(errorOf(undefined), /required/);
});
