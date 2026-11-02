import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Progress, type Task, type TaskQueue, digest, parseWhole, runWorker, waitForBatch } from './tasks.js';

/** A queue of scripted answers to `takeOne`: true, false or an error. */
const scriptedQueue = (answers: readonly (boolean | Error)[], onTake: () => void = () => {}): TaskQueue & { taken: number } => {
    const queue = {
        taken: 0,
        takeOne: async () => {
            const answer = answers[queue.taken] ?? false;
            queue.taken += 1;
            onTake();
            return answer instanceof Error ? Promise.reject(answer) : answer;
        },
        enqueue: async () => 'batch',
        progress: async (): Promise<Progress> => ({ done: 0, open: 0, byWorker: {} }),
        deleteDone: async () => 0,
    };
    return queue;
};

const noWork = async (task: Task): Promise<string> => task.payload;

test('a job argument is a whole number in its range, or the default when left out', () => {
    assert.deepEqual(parseWhole(undefined, 'n', 10, 1, 100), { ok: true, value: 10 });
    assert.deepEqual(parseWhole('100', 'n', 10, 1, 100), { ok: true, value: 100 });
    assert.deepEqual(parseWhole('0', 'hours', 24, 0, 100), { ok: true, value: 0 });
    for (const bad of ['0', '101', '1.5', '-1', '', 'ten', '1e2']) {
        assert.equal(parseWhole(bad, 'n', 10, 1, 100).ok, false, bad);
    }
});

test('a task computes the SHA-256 of its payload', () => {
    assert.equal(digest('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('the worker takes tasks until the queue is empty, then waits before asking again', async () => {
    const stop = new AbortController();
    const waits: number[] = [];
    const queue = scriptedQueue([true, true, false, true], () => {
        if (queue.taken === 4) {
            stop.abort();
        }
    });
    const done = await runWorker(queue, noWork, {
        signal: stop.signal,
        idleMs: 1000,
        retryMs: 2000,
        log: () => {},
        wait: async (ms) => void waits.push(ms),
    });
    assert.equal(done, 3);
    assert.deepEqual(waits, [1000]);
});

test('a failing database is logged and retried, the worker keeps running', async () => {
    const stop = new AbortController();
    const logged: Record<string, unknown>[] = [];
    const waits: number[] = [];
    const queue = scriptedQueue([new Error('connection refused'), new Error('connection refused'), true], () => {
        if (queue.taken === 3) {
            stop.abort();
        }
    });
    const done = await runWorker(queue, noWork, {
        signal: stop.signal,
        idleMs: 1000,
        retryMs: 2000,
        log: (entry) => void logged.push(entry),
        wait: async (ms) => void waits.push(ms),
    });
    assert.equal(done, 1);
    assert.deepEqual(waits, [2000, 2000]);
    assert.deepEqual(logged.map((entry) => entry['error']), ['Error: connection refused', 'Error: connection refused']);
});

test('a stop that came during a take ends the loop without waiting', async () => {
    const stop = new AbortController();
    const queue = scriptedQueue([new Error('connection refused')], () => stop.abort());
    const started = Date.now();
    await runWorker(queue, noWork, { signal: stop.signal, idleMs: 60_000, retryMs: 60_000, log: () => {} });
    assert.ok(Date.now() - started < 5000);
});

test('a stop cuts the idle wait short', async () => {
    const stop = new AbortController();
    const queue = scriptedQueue([], () => setTimeout(() => stop.abort(), 10));
    const started = Date.now();
    await runWorker(queue, noWork, { signal: stop.signal, idleMs: 60_000, retryMs: 60_000, log: () => {} });
    assert.ok(Date.now() - started < 5000);
    assert.equal(queue.taken, 1);
});

test('the wait for a batch ends once all its tasks are done, and logs only changes', async () => {
    const answers: (Progress | Error)[] = [
        { done: 0, open: 3, byWorker: {} },
        { done: 0, open: 3, byWorker: {} },
        new Error('connection refused'),
        { done: 2, open: 1, byWorker: { a: 2 } },
        // cleanup deleted the done tasks meanwhile: no open task is still the end
        { done: 1, open: 0, byWorker: { b: 1 } },
    ];
    let read = 0;
    const queue: TaskQueue = {
        ...scriptedQueue([]),
        progress: async () => {
            const answer = answers[read] as Progress | Error;
            read += 1;
            return answer instanceof Error ? Promise.reject(answer) : answer;
        },
    };
    const logged: Record<string, unknown>[] = [];
    const progress = await waitForBatch(queue, 'batch', 3, { intervalMs: 1000, log: (entry) => void logged.push(entry), wait: async () => {} });
    assert.deepEqual(progress.byWorker, { b: 1 });
    assert.deepEqual(
        logged.map((entry) => entry['done'] ?? entry['error']),
        [0, 'Error: connection refused', 2],
    );
});
