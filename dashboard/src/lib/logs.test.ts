import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LogEntry } from '@openupstream/sdk';
import { appended, lineTime, podLabel, severalPods } from './logs';

const entry = (line: string, pod = 'svc-1-7c9d8f6b5-x2k4q'): LogEntry => ({ pod, site: 'hetzner-fsn1', time: '2026-11-17T07:18:18.123456789Z', line, previous: false });

test('new lines go after the old ones, and the oldest go once there are too many', () => {
    const lines = [entry('a'), entry('b')];
    assert.equal(appended(lines, []), lines);
    assert.deepEqual(appended(lines, [entry('c')]).map((line) => line.line), ['a', 'b', 'c']);
    assert.deepEqual(appended(lines, [entry('c'), entry('d')], 3).map((line) => line.line), ['b', 'c', 'd']);
});

test('a pod by the end of its name, a time of day from nanoseconds', () => {
    assert.equal(podLabel('svc-1-7c9d8f6b5-x2k4q'), 'x2k4q');
    assert.equal(podLabel('pod'), 'pod');
    assert.match(lineTime('2026-11-17T07:18:18.123456789Z'), /^\d{2}:\d{2}:18$/);
    assert.equal(lineTime('not a time'), 'not a time');
});

test('lines say their pod only when there are several', () => {
    assert.equal(severalPods([]), false);
    assert.equal(severalPods([entry('a'), entry('b')]), false);
    assert.equal(severalPods([entry('a'), entry('b', 'svc-1-7c9d8f6b5-9zzzz')]), true);
});
