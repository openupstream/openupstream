import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callerFrom } from './auth.js';

const audience = 'openupstream-control-plane';
const username = 'system:serviceaccount:openupstream-system:databases-operator';

test('an authenticated token for our audience names its ServiceAccount', () => {
    assert.deepEqual(callerFrom({ authenticated: true, audiences: [audience], username }, audience), {
        ok: true,
        value: { username },
    });
});

test("a token for the API server's audience is not enough", () => {
    const result = callerFrom({ authenticated: true, audiences: [], username }, audience);
    assert.deepEqual(result, { ok: false, error: { kind: 'unauthenticated', reason: `token not issued for ${audience}` } });
    assert.equal(callerFrom({ authenticated: true, username }, audience).ok, false);
    assert.equal(callerFrom({ authenticated: true, audiences: ['https://kubernetes.default.svc'], username }, audience).ok, false);
});

test('an unauthenticated token is refused with the reason the API server gave', () => {
    assert.deepEqual(callerFrom({ authenticated: false, error: 'token expired' }, audience), {
        ok: false,
        error: { kind: 'unauthenticated', reason: 'token expired' },
    });
    assert.equal(callerFrom({}, audience).ok, false);
});
