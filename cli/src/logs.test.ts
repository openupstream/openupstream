import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLogEntry, parseTail, podSuffix } from './logs.js';

const entry = { pod: 'svc-7f3c2a1e-0000-4000-8000-000000000001-6d9f8b7c4-x2k9p', site: 'ovh-lim' as const, time: '2026-11-09T10:00:00.5Z', line: 'GET / 200', previous: false };

test("a replica is told apart by its pod name's last part", () => {
    assert.equal(podSuffix(entry.pod), 'x2k9p');
    assert.equal(podSuffix('nohyphen'), 'nohyphen');
});

test('a line with the replica it came from, before its last restart, and its time as asked', () => {
    assert.equal(formatLogEntry(entry, { prefix: true, timestamps: false }), '[x2k9p] GET / 200');
    assert.equal(formatLogEntry({ ...entry, previous: true }, { prefix: true, timestamps: true }), '2026-11-09T10:00:00.5Z [x2k9p previous] GET / 200');
    assert.equal(formatLogEntry(entry, { prefix: false, timestamps: false }), 'GET / 200');
    assert.equal(formatLogEntry({ ...entry, previous: true }, { prefix: false, timestamps: false }), '[previous] GET / 200');
});

test('--tail is a whole number the API takes', () => {
    assert.deepEqual(parseTail(undefined), { ok: true, value: undefined });
    assert.deepEqual(parseTail('0'), { ok: true, value: 0 });
    assert.equal(parseTail('-1').ok, false);
    assert.equal(parseTail('1.5').ok, false);
    assert.equal(parseTail('10001').ok, false);
});
