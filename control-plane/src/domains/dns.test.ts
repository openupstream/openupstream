import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Resolver } from 'node:dns/promises';
import { txtLookup } from './dns.js';

/** A resolver that answers `records`, or fails with the error code `code`. */
const resolver = (answer: string[][] | { code: string }): Resolver =>
    ({
        resolveTxt: async () => {
            if (Array.isArray(answer)) return answer;
            throw Object.assign(new Error(`query failed: ${answer.code}`), answer);
        },
    }) as unknown as Resolver;

test('a TXT record split into strings is joined', async () => {
    assert.deepEqual(await txtLookup(resolver([['abc', 'def'], ['v=spf1 -all']]))('_openupstream.shop.example'), {
        ok: true,
        value: ['abcdef', 'v=spf1 -all'],
    });
});

test('a name without TXT records answers none; a failed lookup is an error', async () => {
    assert.deepEqual(await txtLookup(resolver({ code: 'ENOTFOUND' }))('x'), { ok: true, value: [] });
    assert.deepEqual(await txtLookup(resolver({ code: 'ENODATA' }))('x'), { ok: true, value: [] });
    assert.deepEqual(await txtLookup(resolver({ code: 'ETIMEOUT' }))('x'), { ok: false, error: 'ETIMEOUT' });
});
