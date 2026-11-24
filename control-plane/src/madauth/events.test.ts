import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type ControlPlaneCall, type SendResult, RETRY_FOR_MS, controlPlaneSender, deliver, retryDelay } from './events.js';

const call: ControlPlaneCall = { event: 'user.deleted', method: 'DELETE', path: '/internal/v1/users/usr_dora' };

/** A clock that only moves when the delivery sleeps, and a sender answering from a script. */
const run = async (answers: readonly SendResult[], fallback: SendResult = { outcome: 'retry', detail: 'down' }) => {
    let clock = 0;
    const sleeps: number[] = [];
    const logs: Record<string, unknown>[] = [];
    let sent = 0;
    const done = await deliver(call, {
        send: async () => answers[sent++] ?? fallback,
        log: (entry) => logs.push(entry),
        now: () => clock,
        sleep: async (ms) => {
            sleeps.push(ms);
            clock += ms;
        },
    });
    return { done, sleeps, logs, sent };
};

test('a call the control plane takes at once is not retried', async () => {
    const { done, sleeps, logs } = await run([{ outcome: 'done' }]);
    assert.equal(done, true);
    assert.deepEqual(sleeps, []);
    assert.deepEqual(logs, []);
});

test('while the control plane is away, the call is retried with doubling waits until it is taken', async () => {
    const { done, sleeps, logs } = await run([{ outcome: 'retry' }, { outcome: 'retry' }, { outcome: 'retry' }, { outcome: 'done' }]);
    assert.equal(done, true);
    assert.deepEqual(sleeps, [1_000, 2_000, 4_000]);
    assert.equal(logs.at(-1)?.['msg'], 'madauth event passed on after retrying');
});

test('a refused call is given up at once', async () => {
    const { done, sleeps, logs } = await run([{ outcome: 'refused', detail: 'HTTP 403' }]);
    assert.equal(done, false);
    assert.deepEqual(sleeps, []);
    assert.equal(logs[0]?.['detail'], 'HTTP 403');
});

test('after an hour of failures the call is given up and logged', async () => {
    const { done, sleeps, logs } = await run([]);
    assert.equal(done, false);
    assert.ok(sleeps.reduce((sum, ms) => sum + ms, 0) <= RETRY_FOR_MS);
    assert.ok(sleeps.every((ms) => ms <= 5 * 60 * 1000));
    assert.match(String(logs.at(-1)?.['msg']), /given up/);
});

test('retry delays double from a second and stop at five minutes', () => {
    assert.deepEqual([0, 1, 2, 8, 9, 30].map(retryDelay), [1_000, 2_000, 4_000, 256_000, 300_000, 300_000]);
});

test('the sender sends the token it reads each time, and sorts answers into done, retry and refused', async () => {
    const requests: { url: string; method: string | undefined; authorization: string | null }[] = [];
    const statuses = [204, 503, 401, 429, 403, 404];
    const fetcher = (async (url: URL, init?: RequestInit) => {
        requests.push({ url: url.href, method: init?.method, authorization: new Headers(init?.headers).get('authorization') });
        return new Response(null, { status: statuses[requests.length - 1] ?? 500 });
    }) as typeof fetch;
    let reads = 0;
    const send = controlPlaneSender('http://control-plane:8081', async () => `token-${(reads += 1)}\n`, fetcher);
    const outcomes = [];
    for (const _ of statuses) {
        outcomes.push((await send(call)).outcome);
    }
    assert.deepEqual(outcomes, ['done', 'retry', 'retry', 'retry', 'refused', 'refused']);
    assert.deepEqual(requests[0], { url: 'http://control-plane:8081/internal/v1/users/usr_dora', method: 'DELETE', authorization: 'Bearer token-1' });
    assert.equal(requests[5]?.authorization, 'Bearer token-6');
});

test('an unreadable token or an unreachable control plane is retried', async () => {
    const unreachable = controlPlaneSender('http://control-plane:8081', async () => 't', (async () => {
        throw new Error('ECONNREFUSED');
    }) as typeof fetch);
    assert.deepEqual(await unreachable(call), { outcome: 'retry', detail: 'ECONNREFUSED' });
    const noToken = controlPlaneSender('http://control-plane:8081', async () => {
        throw new Error('ENOENT');
    });
    assert.equal((await noToken(call)).outcome, 'retry');
});
