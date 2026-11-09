import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { LogEntry } from '@openupstream/sdk';
import type { PodInfo, PodLogOptions } from '../kube.js';
import { err, ok } from '../result.js';
import { type LogKube, firstRead, logsOf, openLogStream, parseLogLine, timeKey } from './stream.js';

/** A followed log the test writes into and ends. */
interface Live {
    readonly options: PodLogOptions;
    write(raw: string): void;
    end(): void;
}

/**
 * Kubernetes as far as logs go: `pods` as listed now, `written` lines per
 * `pod/container` (and `pod/container/previous`), and the followed reads,
 * which get the lines written so far and then whatever `live` writes.
 */
const fakeKube = () => {
    let pods: PodInfo[] = [];
    let listFails = false;
    const written = new Map<string, string[]>();
    const live: Live[] = [];
    const reads: { key: string; options: PodLogOptions }[] = [];
    const kube: LogKube = {
        listPods: async () => (listFails ? err('connection refused') : ok(pods)),
        nodeSite: async (node) => ok(node === 'fsn1-a' ? 'hetzner-fsn1' : node === 'lim-a' ? 'ovh-lim' : undefined),
        podLog: async (_namespace, pod, container, options, signal) => {
            const key = `${pod}/${container}${options.previous ? '/previous' : ''}`;
            reads.push({ key, options });
            const lines = written.get(key);
            if (lines === undefined) {
                return err('container not found');
            }
            const tail = options.tailLines === undefined ? lines : lines.slice(-options.tailLines);
            if (!options.follow) {
                return ok(
                    (async function* () {
                        yield* tail;
                    })(),
                );
            }
            const queued = [...tail];
            let ended = false;
            let wake: (() => void) | undefined;
            const notify = () => {
                wake?.();
                wake = undefined;
            };
            signal.addEventListener('abort', () => {
                ended = true;
                notify();
            });
            live.push({
                options,
                write: (raw) => {
                    queued.push(raw);
                    notify();
                },
                end: () => {
                    ended = true;
                    notify();
                },
            });
            return ok(
                (async function* () {
                    while (true) {
                        if (queued.length > 0) {
                            yield queued.shift() as string;
                        } else if (ended) {
                            return;
                        } else {
                            await new Promise<void>((resolve) => {
                                wake = resolve;
                            });
                        }
                    }
                })(),
            );
        },
    };
    return {
        kube,
        written,
        live,
        reads,
        setPods: (next: PodInfo[]) => {
            pods = next;
        },
        failList: (fails: boolean) => {
            listFails = fails;
        },
    };
};

const pod = (name: string, state: 'waiting' | 'running' | 'terminated', restartCount = 0, nodeName: string | undefined = 'fsn1-a'): PodInfo => ({
    name,
    nodeName,
    containers: [{ name: 'app', state, restartCount }],
});

const options = (overrides: Partial<{ tail: number; follow: boolean; pollMs: number; maxMs: number }> = {}) => ({
    namespace: 'project-x',
    selector: 'openupstream.io/service-id=s',
    tail: 100,
    follow: false,
    pollMs: 20,
    maxMs: 5_000,
    ...overrides,
});

const collect = async (entries: AsyncIterable<LogEntry>) => {
    const all: LogEntry[] = [];
    for await (const entry of entries) {
        all.push(entry);
    }
    return all;
};

/** Waits until `check` holds, up to a second. */
const until = async (check: () => boolean) => {
    for (let attempt = 0; attempt < 100 && !check(); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(check(), 'condition not reached');
};

describe('log lines', () => {
    test('the timestamp is split off at the first space; the line keeps its own spaces', () => {
        assert.deepEqual(parseLogLine('2026-11-09T10:00:00.5Z GET /  200'), { time: '2026-11-09T10:00:00.5Z', line: 'GET /  200' });
        assert.deepEqual(parseLogLine('2026-11-09T10:00:00Z'), { time: '2026-11-09T10:00:00Z', line: '' });
    });

    test("a line without a time is the kubelet's own message, not output", () => {
        assert.equal(parseLogLine('unable to retrieve container logs for containerd://d086'), undefined);
    });

    test('which logs hold output: the crash before a running container, the crashed run while waiting, the ended container itself', () => {
        assert.deepEqual(logsOf({ name: 'app', state: 'running', restartCount: 0 }), { previous: false, current: true });
        assert.deepEqual(logsOf({ name: 'app', state: 'running', restartCount: 2 }), { previous: true, current: true });
        assert.deepEqual(logsOf({ name: 'app', state: 'waiting', restartCount: 0 }), { previous: false, current: false });
        assert.deepEqual(logsOf({ name: 'app', state: 'waiting', restartCount: 3 }), { previous: true, current: false });
        assert.deepEqual(logsOf({ name: 'app', state: 'terminated', restartCount: 3 }), { previous: false, current: true });
    });

    test('times sort by what they stand for, though the kubelet drops trailing zeros', () => {
        const times = ['2026-11-09T10:00:00.5Z', '2026-11-09T10:00:00.123456789Z', '2026-11-09T10:00:00Z', '2026-11-09T10:00:01.01Z'];
        assert.deepEqual(
            [...times].sort((a, b) => (timeKey(a) < timeKey(b) ? -1 : 1)),
            ['2026-11-09T10:00:00Z', '2026-11-09T10:00:00.123456789Z', '2026-11-09T10:00:00.5Z', '2026-11-09T10:00:01.01Z'],
        );
    });
});

describe('log stream', () => {
    test('Kubernetes unreachable before the stream starts: an error, no stream', async () => {
        const fake = fakeKube();
        fake.failList(true);
        const opened = await openLogStream(fake.kube, options(), new AbortController().signal);
        assert.equal(opened.ok, false);
    });

    test('without follow: the tail of every replica, sorted by time, with its Site; a waiting container is skipped', async () => {
        const fake = fakeKube();
        fake.setPods([pod('a', 'running'), pod('b', 'running', 0, 'lim-a'), pod('c', 'waiting')]);
        fake.written.set('a/app', ['2026-11-09T10:00:00.1Z one', '2026-11-09T10:00:00.3Z three', '2026-11-09T10:00:00.5Z five']);
        fake.written.set('b/app', ['2026-11-09T10:00:00.2Z two', '2026-11-09T10:00:00.4Z four']);
        const opened = await openLogStream(fake.kube, options({ tail: 2 }), new AbortController().signal);
        assert.ok(opened.ok);
        const entries = await collect(opened.value);
        assert.deepEqual(
            entries.map((entry) => `${entry.pod} ${entry.site} ${entry.line}`),
            ['b ovh-lim two', 'a hetzner-fsn1 three', 'b ovh-lim four', 'a hetzner-fsn1 five'],
        );
        assert.ok(!fake.reads.some((read) => read.key.startsWith('c/')));
    });

    test('a container that restarted: what it wrote before it died comes first, marked previous', async () => {
        const fake = fakeKube();
        fake.setPods([pod('a', 'running', 1, 'unlabelled')]);
        fake.written.set('a/app/previous', ['2026-11-09T09:59:59Z panic: no DATABASE_URL']);
        fake.written.set('a/app', ['2026-11-09T10:00:01Z listening']);
        const opened = await openLogStream(fake.kube, options(), new AbortController().signal);
        assert.ok(opened.ok);
        assert.deepEqual(await collect(opened.value), [
            { pod: 'a', site: null, time: '2026-11-09T09:59:59Z', line: 'panic: no DATABASE_URL', previous: true },
            { pod: 'a', site: null, time: '2026-11-09T10:00:01Z', line: 'listening', previous: false },
        ]);
    });

    test('a crash-looping replica: the run that crashed, from the previous log; a line from the kubelet is dropped', async () => {
        const fake = fakeKube();
        fake.setPods([pod('a', 'waiting', 3)]);
        fake.written.set('a/app/previous', ['2026-11-09T10:00:00Z panic: no DATABASE_URL', 'unable to retrieve container logs for containerd://d086']);
        const opened = await openLogStream(fake.kube, options(), new AbortController().signal);
        assert.ok(opened.ok);
        assert.deepEqual(
            (await collect(opened.value)).map((entry) => [entry.line, entry.previous]),
            [['panic: no DATABASE_URL', true]],
        );
        assert.deepEqual(
            fake.reads.map((read) => read.key),
            ['a/app/previous'],
        );
    });

    test('follow: the tail, then new lines; a replica that starts later is added; the client going ends it', async () => {
        const fake = fakeKube();
        fake.setPods([pod('a', 'running')]);
        fake.written.set('a/app', ['2026-11-09T10:00:00Z old']);
        const stop = new AbortController();
        const opened = await openLogStream(fake.kube, options({ follow: true }), stop.signal);
        assert.ok(opened.ok);
        const seen: string[] = [];
        const reading = (async () => {
            for await (const entry of opened.value) {
                seen.push(`${entry.pod} ${entry.line}`);
            }
        })();
        await until(() => seen.length === 1);
        fake.live[0]?.write('2026-11-09T10:00:01Z new');
        await until(() => seen.length === 2);
        fake.written.set('b/app', ['2026-11-09T10:00:02Z b started']);
        fake.setPods([pod('a', 'running'), pod('b', 'running')]);
        await until(() => seen.length === 3);
        stop.abort();
        await reading;
        assert.deepEqual(seen, ['a old', 'a new', 'b b started']);
    });

    test('follow: a restarted container is read again from the last line sent, without repeating it', async () => {
        const fake = fakeKube();
        fake.setPods([pod('a', 'running')]);
        fake.written.set('a/app', ['2026-11-09T10:00:00.25Z before']);
        const stop = new AbortController();
        const opened = await openLogStream(fake.kube, options({ follow: true }), stop.signal);
        assert.ok(opened.ok);
        const seen: string[] = [];
        const reading = (async () => {
            for await (const entry of opened.value) {
                seen.push(entry.line);
            }
        })();
        await until(() => seen.length === 1);
        // The container crashed and came back: the new one's log, from the same second on.
        fake.written.set('a/app', ['2026-11-09T10:00:00.25Z before', '2026-11-09T10:00:00.5Z after']);
        fake.setPods([pod('a', 'running', 1)]);
        fake.live[0]?.end();
        await until(() => seen.length === 2);
        assert.equal(fake.live[1]?.options.sinceTime, '2026-11-09T10:00:00Z');
        stop.abort();
        await reading;
        assert.deepEqual(seen, ['before', 'after']);
    });

    test('follow: ends by itself once a run has finished', async () => {
        const fake = fakeKube();
        fake.setPods([pod('run-1', 'running')]);
        fake.written.set('run-1/app', ['2026-11-09T10:00:00Z working']);
        const opened = await openLogStream(fake.kube, options({ follow: true, pollMs: 60_000 }), new AbortController().signal);
        assert.ok(opened.ok);
        const reading = collect(opened.value);
        await until(() => fake.live.length === 1);
        fake.live[0]?.write('2026-11-09T10:00:01Z done');
        fake.setPods([pod('run-1', 'terminated')]);
        fake.live[0]?.end();
        assert.deepEqual(
            (await reading).map((entry) => entry.line),
            ['working', 'done'],
        );
    });

    test('tail 0: Kubernetes is asked from now on, never for tailLines=0, which it takes for all', () => {
        assert.deepEqual(firstRead(5, '2026-11-09T10:00:00.25Z'), { tailLines: 5 });
        assert.deepEqual(firstRead(0, '2026-11-09T10:00:00.25Z'), { sinceTime: '2026-11-09T10:00:00Z', after: '2026-11-09T10:00:00.25Z' });
    });

    test('tail 0 without follow: nothing is read', async () => {
        const fake = fakeKube();
        fake.setPods([pod('a', 'running')]);
        fake.written.set('a/app', ['2026-11-09T10:00:00Z old']);
        const opened = await openLogStream(fake.kube, options({ tail: 0 }), new AbortController().signal);
        assert.ok(opened.ok);
        assert.deepEqual(await collect(opened.value), []);
        assert.deepEqual(fake.reads, []);
    });

    test('follow tail 0: only what is written from now on, and no previous log', async () => {
        const fake = fakeKube();
        fake.setPods([pod('a', 'running', 1)]);
        fake.written.set('a/app', []);
        fake.written.set('a/app/previous', ['2026-11-09T09:00:00Z crash']);
        const stop = new AbortController();
        const opened = await openLogStream(fake.kube, options({ tail: 0, follow: true }), stop.signal);
        assert.ok(opened.ok);
        const reading = collect(opened.value);
        await until(() => fake.live.length === 1);
        assert.equal(fake.live[0]?.options.tailLines, undefined);
        assert.match(fake.live[0]?.options.sinceTime ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        stop.abort();
        assert.deepEqual(await reading, []);
        assert.ok(!fake.reads.some((read) => read.key.endsWith('/previous')));
    });

    test('follow: a container that restarted long ago gets its tail, not everything since the crash', async () => {
        const fake = fakeKube();
        fake.setPods([pod('a', 'running', 1)]);
        fake.written.set('a/app/previous', ['2026-11-06T10:00:00Z crash']);
        fake.written.set('a/app', ['2026-11-06T10:00:05Z day 1', '2026-11-09T10:00:00Z today']);
        const stop = new AbortController();
        const opened = await openLogStream(fake.kube, options({ tail: 1, follow: true }), stop.signal);
        assert.ok(opened.ok);
        const reading = collect(opened.value);
        await until(() => fake.live.length === 1);
        assert.equal(fake.live[0]?.options.tailLines, 1);
        assert.equal(fake.live[0]?.options.sinceTime, undefined);
        stop.abort();
        assert.deepEqual(
            (await reading).map((entry) => entry.line),
            ['crash', 'today'],
        );
    });

    test('follow with a client that went already: ends at once', async () => {
        const fake = fakeKube();
        fake.setPods([pod('a', 'running')]);
        fake.written.set('a/app', ['2026-11-09T10:00:00Z old']);
        const stop = new AbortController();
        stop.abort();
        const opened = await openLogStream(fake.kube, options({ follow: true }), stop.signal);
        assert.ok(opened.ok);
        assert.deepEqual(await collect(opened.value), []);
    });

    test('follow: ends at maxMs', async () => {
        const fake = fakeKube();
        fake.setPods([pod('a', 'running')]);
        fake.written.set('a/app', []);
        const opened = await openLogStream(fake.kube, options({ follow: true, maxMs: 50 }), new AbortController().signal);
        assert.ok(opened.ok);
        assert.deepEqual(await collect(opened.value), []);
    });
});
