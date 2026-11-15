import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_BITS, MIN_BITS, type Shaper, bitsPerSecond, burstFor, directionsOf, fairShare, limitFor, needsChange, shapersOf, tcArgs } from './shares.js';

const M = 1_000_000;

// As the dev cluster's node printed them (2026-11-15), shortened.
const links = JSON.stringify([
    { ifname: 'enp4s0', link_type: 'ether' },
    { ifname: 'cni0', linkinfo: { info_kind: 'bridge' } },
    { ifname: 'vethd0b07ec9', master: 'cni0', linkinfo: { info_kind: 'veth' } },
    { ifname: 'vethe364ae05', master: 'cni0', linkinfo: { info_kind: 'veth' } },
    { ifname: 'bwpc3fdcca33e57', linkinfo: { info_kind: 'ifb' } },
]);
const qdiscs = JSON.stringify([
    { kind: 'noqueue', handle: '0:', dev: 'vethd0b07ec9', root: true, options: {}, bytes: 0 },
    { kind: 'tbf', handle: '1:', dev: 'vethe364ae05', root: true, options: { rate: 37500000, burst: 536870887, lat: 25000 }, bytes: 994600355 },
    { kind: 'ingress', handle: 'ffff:', dev: 'vethe364ae05', parent: 'ffff:fff1', options: {}, bytes: 5 },
    { kind: 'tbf', handle: '1:', dev: 'bwpc3fdcca33e57', root: true, options: { rate: 37500000, burst: 536870887, lat: 25000 }, bytes: 682014098 },
    { kind: 'tbf', handle: '1:', dev: 'enp4s0', root: true, options: { rate: 1000, burst: 1000, lat: 1 }, bytes: 1 },
]);

test("a pod's interface on the node limits what it receives, its ifb device what it sends; other devices are left alone", () => {
    const directions = directionsOf(links);
    assert.deepEqual([...directions], [
        ['vethd0b07ec9', 'ingress'],
        ['vethe364ae05', 'ingress'],
        ['bwpc3fdcca33e57', 'egress'],
    ]);
    // Only the pods with a token bucket, in bits per second; not the uplink's own, were it to have one.
    assert.deepEqual(shapersOf(qdiscs, directions), [
        { dev: 'vethe364ae05', direction: 'ingress', rateBits: 300 * M, burstBytes: 536870887, bytes: 994600355 },
        { dev: 'bwpc3fdcca33e57', direction: 'egress', rateBits: 300 * M, burstBytes: 536870887, bytes: 682014098 },
    ]);
});

test('output that is not a JSON list gives no devices', () => {
    assert.deepEqual([...directionsOf('')], []);
    assert.deepEqual(shapersOf('Cannot open netlink socket', directionsOf(links)), []);
});

test('usage is the bytes between two readings; a counter that started again counts as none', () => {
    assert.equal(bitsPerSecond(1_000_000, 2_250_000, 1), 10 * M);
    assert.equal(bitsPerSecond(1_000_000, 2_250_000, 2), 5 * M);
    assert.equal(bitsPerSecond(5_000, 100, 1), 0);
    assert.equal(bitsPerSecond(0, 100, 0), 0);
});

test('a fair share meets small demands in full and splits the rest equally', () => {
    assert.equal(fairShare([300, 300, 300, 300], 800), 200);
    assert.equal(fairShare([300, 10, 300, 20], 630), Infinity);
    assert.equal(fairShare([300, 10, 300, 20], 430), 200);
    assert.equal(fairShare([100, 200], 300), Infinity);
    assert.equal(fairShare([], 0), Infinity);
    assert.equal(fairShare([300, 300], -50), 0);
});

const pod = (usageMbit: number, rateMbit = 300) => ({ rateBits: rateMbit * M, usageBits: usageMbit * M });

test('below 80% of the uplink every pod keeps the maximum', () => {
    assert.equal(limitFor({ pods: [pod(280), pod(280)], uplinkBits: 600 * M, capacityBits: 1000 * M }), MAX_BITS);
    assert.equal(limitFor({ pods: [], uplinkBits: 950 * M, capacityBits: 1000 * M }), MAX_BITS);
});

test('four pods filling a 1 Gbit/s uplink are cut to 200 Mbit/s each, and stay there while they push', () => {
    // The link gives each 250; none is at its limit of 300, but each wants more than it uses.
    assert.equal(limitFor({ pods: [pod(250), pod(250), pod(250), pod(250)], uplinkBits: 1000 * M, capacityBits: 1000 * M }), 200 * M);
    // At 200 each the uplink is at 80%: pods at their limit still count as wanting the maximum.
    const cut = [pod(200, 200), pod(200, 200), pod(200, 200), pod(200, 200)];
    assert.equal(limitFor({ pods: cut, uplinkBits: 800 * M, capacityBits: 1000 * M }), 200 * M);
});

test('when a pod stops the others get its share, and the maximum once there is room for all', () => {
    assert.equal(limitFor({ pods: [pod(200, 200), pod(200, 200), pod(200, 200), pod(0, 200)], uplinkBits: 600 * M, capacityBits: 1000 * M }), 266 * M);
    assert.equal(limitFor({ pods: [pod(200, 200), pod(200, 200), pod(0, 200), pod(0, 200)], uplinkBits: 400 * M, capacityBits: 1000 * M }), MAX_BITS);
});

test('a pod that sends little keeps its traffic; the heavy ones split what is left', () => {
    // 20 Mbit/s of light traffic (25 with room to grow), 780 of heavy: 800 - 25 = 775 for three.
    assert.equal(limitFor({ pods: [pod(20), pod(260), pod(260), pod(260)], uplinkBits: 800 * M + 100 * M, capacityBits: 1000 * M }), 225 * M);
});

test("the platform's own traffic is not limited: the pods give way to it, down to 10 Mbit/s", () => {
    // 600 Mbit/s of Database replication next to two pods at 150 each: 200 left for the pods.
    assert.equal(limitFor({ pods: [pod(150), pod(150)], uplinkBits: 900 * M, capacityBits: 1000 * M }), 100 * M);
    assert.equal(limitFor({ pods: [pod(5, 10), pod(5, 10)], uplinkBits: 1000 * M, capacityBits: 1000 * M }), MIN_BITS);
});

test('without the uplink speed nothing is lowered', () => {
    assert.equal(limitFor({ pods: [pod(300), pod(300)], uplinkBits: 5000 * M, capacityBits: undefined }), MAX_BITS);
});

const shaper = (rateMbit: number, burstBytes: number): Shaper => ({ dev: 'veth0', direction: 'ingress', rateBits: rateMbit * M, burstBytes, bytes: 0 });

test("a new pod's 512 MB burst is replaced by a tenth of a second of its limit", () => {
    assert.equal(burstFor(300 * M), 3_750_000);
    assert.equal(burstFor(MIN_BITS), 125_000);
    assert.equal(burstFor(1 * M), 65_536);
    assert.equal(needsChange(shaper(300, 536870887), MAX_BITS), true);
    // As tc reports our own burst back: a few bytes off.
    assert.equal(needsChange(shaper(300, 3_749_997), MAX_BITS), false);
});

test('a limit is set again when it moves by 5% or reaches either end, not for less', () => {
    assert.equal(needsChange(shaper(200, burstFor(200 * M)), 195 * M), false);
    assert.equal(needsChange(shaper(200, burstFor(200 * M)), 190 * M), true);
    assert.equal(needsChange(shaper(200, burstFor(200 * M)), 266 * M), true);
    assert.equal(needsChange(shaper(295, burstFor(295 * M)), MAX_BITS), true);
    assert.equal(needsChange(shaper(10.2, burstFor(10.2 * M)), MIN_BITS), true);
});

test('tc changes the bucket in place, with the burst for the new limit', () => {
    assert.deepEqual(tcArgs('bwpc3fdcca33e57', 50 * M), [
        'qdisc', 'change', 'dev', 'bwpc3fdcca33e57', 'root', 'handle', '1:', 'tbf', 'rate', '50000000bit', 'burst', '625000', 'latency', '25ms',
    ]);
});
