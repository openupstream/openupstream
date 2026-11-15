import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEEP_MS, endMissing, expire, isPopulated, metricsText, name, observe, podUidOf, usageOf } from './totals.js';

const uid = '236cddd9-2f0d-4393-ae43-bc84814b0fd4';

test("a pod slice's uid, under the systemd driver, for every QoS class", () => {
    assert.equal(podUidOf('kubepods-pod236cddd9_2f0d_4393_ae43_bc84814b0fd4.slice'), uid);
    assert.equal(podUidOf('kubepods-burstable-pod236cddd9_2f0d_4393_ae43_bc84814b0fd4.slice'), uid);
    assert.equal(podUidOf('kubepods-besteffort-pod236cddd9_2f0d_4393_ae43_bc84814b0fd4.slice'), uid);
    assert.equal(podUidOf('kubepods-burstable.slice'), undefined);
    assert.equal(podUidOf('cri-containerd-5eec2683.scope'), undefined);
});

test('cpu.stat and cgroup.events as cgroup v2 writes them', () => {
    assert.equal(usageOf('usage_usec 619160\nuser_usec 400000\nsystem_usec 219160\n'), 0.61916);
    assert.equal(usageOf('user_usec 1\n'), undefined);
    assert.equal(isPopulated('populated 1\nfrozen 0\n'), true);
    assert.equal(isPopulated('populated 0\nfrozen 0\n'), false);
});

test('a new cgroup is empty before its first process: not an end', () => {
    let totals = observe(new Map(), uid, 0, 0, false);
    assert.deepEqual(totals.get(uid), { seconds: 0 });
    totals = observe(totals, uid, 0.05, 300, true);
    totals = observe(totals, uid, 0.62, 4_300, false);
    assert.deepEqual(totals.get(uid), { seconds: 0.62, ran: true, endedAt: 4_300 });
});

test('a short run: read while running, final when empty, then kept, named once listed, and dropped after 15 minutes', () => {
    let totals = observe(new Map(), uid, 0.05, 0, true);
    totals = observe(totals, uid, 0.62, 4_300, false);
    assert.deepEqual(totals.get(uid), { seconds: 0.62, ran: true, endedAt: 4_300 });
    assert.equal(observe(totals, uid, 0.7, 4_400, true), totals, 'nothing changes a final total');
    assert.equal(metricsText(totals).includes(uid), false, 'unnamed pods are not exported');
    totals = name(totals, new Map([[uid, { namespace: 'project-x', pod: 'job-y-1-abcde' }]]));
    assert.match(metricsText(totals), /^openupstream_pod_cpu_usage_seconds_total\{namespace="project-x",pod="job-y-1-abcde",uid="236cddd9-2f0d-4393-ae43-bc84814b0fd4"\} 0\.62$/m);
    assert.equal(expire(totals, 4_300 + KEEP_MS - 1).size, 1);
    assert.equal(expire(totals, 4_300 + KEEP_MS).size, 0);
});

test('totals only grow; a pod whose cgroup vanished between readings ends with its last one', () => {
    let totals = observe(new Map(), uid, 2, 0, true);
    totals = observe(totals, uid, 1, 1_000, true);
    assert.equal(totals.get(uid)?.seconds, 2);
    totals = endMissing(totals, new Set(), 2_000);
    assert.deepEqual(totals.get(uid), { seconds: 2, ran: true, endedAt: 2_000 });
    assert.equal(endMissing(totals, new Set(), 3_000), totals, 'ended once');
});
