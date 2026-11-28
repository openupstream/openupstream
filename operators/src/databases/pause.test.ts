import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Kube, KubeError, KubeObject } from '../kube.js';
import { type Result, err, ok } from '../result.js';
import {
    GUARD_FIELD_MANAGER,
    type GuardState,
    type GuardStates,
    IDLE,
    MAX_PAUSE_MS,
    PAUSED_BY_ANNOTATION,
    guardClusters,
    guardTick,
    pausePatch,
    pausedOf,
    primaryPodOf,
    resumeLeftovers,
    runGuard,
    step,
} from './pause.js';

const RESTART = 'Primary instance is being restarted without a switchover';
const HEALTHY = 'Cluster in healthy state';
const serving = (uid: string) => ({ uid, serving: true });
const down = (uid: string) => ({ uid, serving: false });
const paused = (overrides: Partial<Extract<GuardState, { kind: 'paused' }>> = {}): GuardState => ({ kind: 'paused', oldUid: 'old', sawDown: false, sinceMs: 0, ...overrides });

test('a restart of the primary pauses the Pooler once, and a new pod that serves resumes it', () => {
    assert.deepEqual(step(IDLE, false, serving('old'), 0), { state: IDLE, action: 'none' });
    const start = step(IDLE, true, serving('old'), 1000);
    assert.deepEqual(start, { state: { kind: 'paused', oldUid: 'old', sawDown: false, sinceMs: 1000 }, action: 'pause' });
    assert.equal(step(start.state, true, serving('old'), 1250).action, 'none', 'the old primary still waits for its connections to close');
    assert.equal(step(start.state, true, undefined, 3000).action, 'none', 'the pod is gone');
    assert.equal(step(start.state, true, down('new'), 6000).action, 'none', 'the new pod starts');
    const back = step(start.state, true, serving('new'), 15000);
    assert.deepEqual(back, { state: { kind: 'done' }, action: 'resume' });
    assert.deepEqual(step(back.state, true, serving('new'), 15250), { state: { kind: 'done' }, action: 'none' }, 'the phase lags: not paused again');
    assert.deepEqual(step(back.state, false, serving('new'), 17000), { state: IDLE, action: 'none' });
});

test('a restart inside the pod keeps the pod: it must have been seen down before it counts as back', () => {
    const seenDown = step(paused(), true, down('old'), 500);
    assert.deepEqual(seenDown, { state: paused({ sawDown: true }), action: 'none' });
    assert.equal(step(seenDown.state, true, serving('old'), 4000).action, 'resume');
});

test('a Pooler is resumed when the restart is called off or takes too long', () => {
    assert.equal(step(paused(), false, serving('old'), 500).action, 'resume', 'the phase left without a restart');
    assert.equal(step(paused(), false, down('old'), 500).action, 'none', 'not while the primary is down');
    assert.equal(step(paused(), true, down('new'), MAX_PAUSE_MS).action, 'none');
    assert.equal(step(paused(), true, down('new'), MAX_PAUSE_MS + 1).action, 'resume', 'errors are better than waiting on a restart that hangs');
});

test('a primary that had no pod when the Pooler was paused is back with any pod that serves', () => {
    const start = step(IDLE, true, undefined, 0);
    assert.deepEqual(start.state, { kind: 'paused', oldUid: undefined, sawDown: true, sinceMs: 0 });
    assert.equal(step(start.state, true, serving('new'), 5000).action, 'resume');
});

test('a pod serves as primary when it has the role label, is Ready and is not being deleted', () => {
    const pod = (overrides: { role?: string; ready?: string; deleted?: boolean } = {}): KubeObject => ({
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: 'db-1', uid: 'u1', labels: { 'cnpg.io/instanceRole': overrides.role ?? 'primary' }, ...(overrides.deleted ? { deletionTimestamp: new Date('2026-11-28T09:47:09Z') } : {}) },
        status: { conditions: [{ type: 'Ready', status: overrides.ready ?? 'True' }] },
    });
    assert.deepEqual(primaryPodOf(pod()), { uid: 'u1', serving: true });
    assert.deepEqual(primaryPodOf(pod({ ready: 'False' })), { uid: 'u1', serving: false });
    assert.deepEqual(primaryPodOf(pod({ role: 'replica' })), { uid: 'u1', serving: false }, 'the read-write Service does not lead to it yet');
    assert.deepEqual(primaryPodOf(pod({ deleted: true })), { uid: 'u1', serving: false });
    assert.equal(primaryPodOf(undefined), undefined);
});

const cluster = (name: string, phase: string): KubeObject => ({
    apiVersion: 'postgresql.cnpg.io/v1',
    kind: 'Cluster',
    metadata: { name, namespace: 'project-a' },
    status: { phase, currentPrimary: `${name}-1` },
});
const podObject = (uid: string, ready: boolean): KubeObject => ({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'p', uid, labels: { 'cnpg.io/instanceRole': 'primary' } },
    status: { conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] },
});

/** A cluster whose Clusters and primary pods the test sets; records the applies. */
const fake = () => {
    const world = {
        clusters: ok([]) as Result<KubeObject[], KubeError>,
        pods: new Map<string, Result<KubeObject | undefined, KubeError>>(),
        poolers: [] as KubeObject[],
        failApply: false,
    };
    const applied: { object: KubeObject; fieldManager: string | undefined }[] = [];
    const reads: string[] = [];
    const kube: Kube = {
        apply: async (object, { fieldManager }) => {
            applied.push({ object, fieldManager });
            return world.failApply ? err({ status: 500, message: 'no' }) : ok(undefined);
        },
        read: async (ref) => {
            reads.push(ref.name);
            return world.pods.get(ref.name) ?? ok(undefined);
        },
        readSecret: async () => ok(undefined),
        list: async () => ok([]),
        listObjects: async (_apiVersion, kind) => (kind === 'Pooler' ? ok(world.poolers) : world.clusters),
        remove: async () => ok(undefined),
    };
    return { kube, world, applied, reads };
};

test('a tick pauses the Pooler of a Cluster whose primary is being restarted, under its own field manager, and resumes it', async () => {
    const { kube, world, applied, reads } = fake();
    const states: GuardStates = new Map();
    world.clusters = ok([cluster('db-a', HEALTHY), cluster('db-b', HEALTHY)]);
    assert.deepEqual(await guardTick(kube, states, 0), []);
    assert.deepEqual([applied.length, reads.length, states.size], [0, 0, 0], 'healthy Clusters cost one list and nothing else');

    world.clusters = ok([cluster('db-a', RESTART), cluster('db-b', HEALTHY)]);
    world.pods.set('db-a-1', ok(podObject('old', true)));
    const pausedLog = await guardTick(kube, states, 1000);
    assert.deepEqual(applied, [{ object: pausePatch('project-a', 'db-a-pooler', true), fieldManager: GUARD_FIELD_MANAGER }]);
    assert.equal(pausedLog[0]?.msg, 'restart guard: Pooler paused, the primary is being restarted');
    assert.deepEqual(reads, ['db-a-1'], 'only the restarting Cluster');

    world.pods.set('db-a-1', ok(podObject('new', false)));
    assert.deepEqual(await guardTick(kube, states, 1250), []);
    world.pods.set('db-a-1', ok(podObject('new', true)));
    const resumedLog = await guardTick(kube, states, 15000);
    assert.deepEqual(applied[1], { object: pausePatch('project-a', 'db-a-pooler', false), fieldManager: GUARD_FIELD_MANAGER });
    assert.deepEqual(resumedLog, [{ msg: 'restart guard: Pooler resumed', cluster: 'project-a/db-a', heldMs: 14000 }]);

    assert.deepEqual(await guardTick(kube, states, 15250), [], 'the phase lags');
    world.clusters = ok([cluster('db-a', HEALTHY), cluster('db-b', HEALTHY)]);
    await guardTick(kube, states, 17000);
    assert.deepEqual([applied.length, states.size], [2, 0]);
});

test('a failed read or write changes nothing, so the next tick tries again', async () => {
    const { kube, world, applied } = fake();
    const states: GuardStates = new Map();
    world.clusters = ok([cluster('db-a', RESTART)]);
    world.pods.set('db-a-1', err({ status: 0, message: 'no answer' }));
    assert.equal((await guardTick(kube, states, 0))[0]?.msg, "restart guard: cannot read the primary's pod");
    assert.deepEqual([applied.length, states.size], [0, 0]);

    world.pods.set('db-a-1', ok(podObject('old', true)));
    world.failApply = true;
    assert.equal((await guardTick(kube, states, 250))[0]?.msg, 'restart guard: cannot pause the Pooler');
    assert.equal(states.size, 0, 'not recorded as paused');
    world.failApply = false;
    await guardTick(kube, states, 500);
    assert.equal(states.get('project-a/db-a')?.kind, 'paused');

    world.clusters = err({ status: 0, message: 'no answer' });
    assert.equal((await guardTick(kube, states, 750))[0]?.msg, 'restart guard: cannot list the Clusters');
    assert.equal(states.get('project-a/db-a')?.kind, 'paused', 'kept');
});

test('a paused Database whose Cluster is deleted is forgotten', async () => {
    const { kube, world } = fake();
    const states: GuardStates = new Map([['project-a/db-a', { kind: 'paused', oldUid: 'old', sawDown: false, sinceMs: 0 }]]);
    world.clusters = ok([]);
    await guardTick(kube, states, 1000);
    assert.equal(states.size, 0);
});

test('on start, Poolers a guard left paused are resumed; one paused by hand is left alone', async () => {
    const { kube, world, applied } = fake();
    const pooler = (name: string, isPaused: boolean, by?: string): KubeObject => ({
        apiVersion: 'postgresql.cnpg.io/v1',
        kind: 'Pooler',
        metadata: { name, namespace: 'project-a', ...(by === undefined ? {} : { annotations: { [PAUSED_BY_ANNOTATION]: by } }) },
        spec: { pgbouncer: { paused: isPaused } },
    });
    world.poolers = [pooler('db-a-pooler', true, 'restart-guard'), pooler('db-b-pooler', true), pooler('db-c-pooler', false, 'restart-guard')];
    const logs = await resumeLeftovers(kube);
    assert.deepEqual(applied.map(({ object }) => object.metadata.name), ['db-a-pooler']);
    assert.deepEqual(applied[0]?.object['spec'], { pgbouncer: { paused: false } });
    assert.equal(logs[0]?.msg, 'restart guard: resumed a Pooler left paused');
});

test('between two lists only the paused Databases are looked at, by their pods', async () => {
    const { kube, world, applied, reads } = fake();
    const states: GuardStates = new Map();
    const listed = [cluster('db-a', RESTART), cluster('db-b', HEALTHY)];
    world.clusters = ok(listed);
    world.pods.set('db-a-1', ok(podObject('old', true)));
    await guardTick(kube, states, 0);
    assert.deepEqual(pausedOf(listed, states).map((c) => c.metadata.name), ['db-a']);
    world.pods.set('db-a-1', ok(podObject('new', true)));
    const logs = await guardClusters(kube, states, pausedOf(listed, states), 9000);
    assert.equal(logs[0]?.msg, 'restart guard: Pooler resumed');
    assert.deepEqual(applied.map(({ object }) => (object['spec'] as { pgbouncer: { paused: boolean } }).pgbouncer.paused), [true, false]);
    assert.deepEqual(reads, ['db-a-1', 'db-a-1']);
    assert.deepEqual(pausedOf(listed, states), [], 'resumed: back to the slow rhythm');
});

test('the loop lists the Clusters once per interval and reads only pods in between', async () => {
    const { kube, world, applied } = fake();
    let lists = 0;
    const counting: typeof kube = { ...kube, listObjects: async (apiVersion, kind, selector) => { lists += kind === 'Cluster' ? 1 : 0; return kube.listObjects(apiVersion, kind, selector); } };
    world.clusters = ok([cluster('db-a', RESTART)]);
    world.pods.set('db-a-1', ok(podObject('old', true)));
    const stop = new AbortController();
    const running = runGuard(counting, () => undefined, stop.signal);
    await new Promise((resolve) => setTimeout(resolve, 700));
    world.pods.set('db-a-1', ok(podObject('new', true)));
    await new Promise((resolve) => setTimeout(resolve, 500));
    stop.abort();
    await running;
    assert.equal(lists, 1, 'one list in the first 1.2 s');
    assert.deepEqual(applied.map(({ object }) => (object['spec'] as { pgbouncer: { paused: boolean } }).pgbouncer.paused), [true, false]);
});
