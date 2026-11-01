import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KubeJob } from '../kube.js';
import { byNewest, isRunOf, runManifest, runName, runOf } from './runs.js';

const projectId = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';
const template = {
    metadata: { labels: { 'openupstream.io/job-id': jobId, 'openupstream.io/component': 'jobs' } },
    spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: 600,
        template: {
            metadata: { labels: { 'openupstream.io/component': 'jobs' } },
            spec: {
                restartPolicy: 'Never',
                runtimeClassName: 'gvisor',
                containers: [{ name: 'job', image: 'ghcr.io/acme/api@sha256:aa', command: ['node', 'nightly.js'], args: ['--all'] }],
            },
        },
    },
};
type Pod = { runtimeClassName: string; containers: { image: string; command: string[]; args: string[]; env?: { name: string; value: string }[] }[] };
const podOf = (job: KubeJob | undefined) => (job?.spec as { template: { spec: Pod } }).template.spec;

test("a One-off job is a copy of its CronJob's template, owned by it but not controlled", () => {
    const run = runManifest(projectId, jobId, { uid: 'cron-uid', jobTemplate: template }, {}, `job-${jobId}-abc`);
    assert.equal(run?.metadata.name, `job-${jobId}-abc`);
    assert.equal(run?.metadata.namespace, `project-${projectId}`);
    assert.deepEqual(run?.metadata.labels, {
        'openupstream.io/job-id': jobId,
        'openupstream.io/component': 'jobs',
        'openupstream.io/trigger': 'api',
    });
    assert.deepEqual(run?.metadata.ownerReferences, [{ apiVersion: 'batch/v1', kind: 'CronJob', name: `job-${jobId}`, uid: 'cron-uid' }]);
    assert.equal((run?.spec as { activeDeadlineSeconds: number }).activeDeadlineSeconds, 600);
    const pod = podOf(run);
    assert.equal(pod.runtimeClassName, 'gvisor');
    assert.deepEqual(pod.containers[0]?.args, ['--all']);
    assert.equal(pod.containers[0]?.env, undefined);
});

test('a run replaces the args and adds variables, leaving the template as it was', () => {
    const run = runManifest(projectId, jobId, { uid: 'u', jobTemplate: template }, { args: ['--only', '42'], env: { ORDER_ID: '42' } });
    const [container] = podOf(run).containers;
    assert.deepEqual(container?.command, ['node', 'nightly.js']);
    assert.deepEqual(container?.args, ['--only', '42']);
    assert.deepEqual(container?.env, [{ name: 'ORDER_ID', value: '42' }]);
    assert.deepEqual(template.spec.template.spec.containers[0]?.args, ['--all']);
    assert.match(run?.metadata.name ?? '', new RegExp(`^job-${jobId}-[0-9a-f]{8}$`));
});

test('a template the operator did not write is not copied', () => {
    assert.equal(runManifest(projectId, jobId, { uid: 'u', jobTemplate: undefined }, {}), undefined);
    assert.equal(runManifest(projectId, jobId, { uid: 'u', jobTemplate: { spec: { template: { spec: { containers: [] } } } } }, {}), undefined);
});

test("only names of the Job's own runs are looked up", () => {
    assert.equal(isRunOf(jobId, runName(jobId)), true);
    assert.equal(isRunOf(jobId, `job-${jobId}-29384756`), true, 'a scheduled run');
    assert.equal(isRunOf(jobId, `job-${jobId}`), false);
    assert.equal(isRunOf(jobId, `job-${jobId}-ABC`), false);
    assert.equal(isRunOf(jobId, 'job-33333333-3333-4333-8333-333333333333-abc'), false);
});

const kubeJob = (name: string, status: KubeJob['status'], labels: Record<string, string> = {}, created = '2026-11-01T10:00:00Z'): KubeJob => ({
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name, namespace: 'n', labels: { 'openupstream.io/job-id': jobId, ...labels }, creationTimestamp: new Date(created) },
    ...(status === undefined ? {} : { status }),
});

test('the state of a run is read from its Kubernetes Job', () => {
    const at = (time: string) => new Date(`2026-11-01T${time}Z`);
    assert.deepEqual(runOf(kubeJob('a', undefined, { 'openupstream.io/trigger': 'api' })), {
        id: 'a',
        jobId,
        trigger: 'api',
        createdAt: '2026-11-01T10:00:00.000Z',
        startedAt: null,
        state: 'pending',
        reason: null,
        finishedAt: null,
    });
    assert.equal(runOf(kubeJob('b', { active: 1, ready: 0, startTime: at('10:00:01') })).state, 'pending');
    const running = runOf(kubeJob('c', { active: 1, ready: 1, startTime: at('10:00:01') }));
    assert.deepEqual([running.state, running.trigger, running.startedAt], ['running', 'schedule', '2026-11-01T10:00:01.000Z']);
    const done = runOf(
        kubeJob('d', { startTime: at('10:00:01'), completionTime: at('10:05:00'), conditions: [{ type: 'Complete', status: 'True' }] }),
    );
    assert.deepEqual([done.state, done.finishedAt], ['succeeded', '2026-11-01T10:05:00.000Z']);
    const timedOut = runOf(
        kubeJob('e', {
            conditions: [
                { type: 'FailureTarget', status: 'True', reason: 'DeadlineExceeded' },
                { type: 'Failed', status: 'True', reason: 'DeadlineExceeded', lastTransitionTime: at('11:00:00') },
            ],
        }),
    );
    assert.deepEqual([timedOut.state, timedOut.reason, timedOut.finishedAt], ['failed', 'DeadlineExceeded', '2026-11-01T11:00:00.000Z']);
});

test('the outcome counts from the moment the Job controller decides it, before its pod is gone', () => {
    const at = (time: string) => new Date(`2026-11-01T${time}Z`);
    const ending = runOf(
        kubeJob('f', {
            ready: 0,
            startTime: at('10:00:01'),
            conditions: [{ type: 'FailureTarget', status: 'True', reason: 'DeadlineExceeded', lastTransitionTime: at('10:10:01') }],
        }),
    );
    assert.deepEqual([ending.state, ending.reason, ending.finishedAt], ['failed', 'DeadlineExceeded', '2026-11-01T10:10:01.000Z']);
    const succeeding = runOf(
        kubeJob('g', { ready: 0, startTime: at('10:00:01'), conditions: [{ type: 'SuccessCriteriaMet', status: 'True', lastTransitionTime: at('10:02:00') }] }),
    );
    assert.deepEqual([succeeding.state, succeeding.finishedAt], ['succeeded', '2026-11-01T10:02:00.000Z']);
});

test('runs are listed newest first', () => {
    const runs = [kubeJob('old', undefined, {}, '2026-11-01T09:00:00Z'), kubeJob('new', undefined, {}, '2026-11-01T11:00:00Z')].map(runOf);
    assert.deepEqual(runs.sort(byNewest).map((run) => run.id), ['new', 'old']);
});
