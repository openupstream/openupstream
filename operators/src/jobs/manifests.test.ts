import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type JobRow, jobSpecVersion } from '@openupstream/sdk';
import type { Kube, KubeObject, ObjectRef } from '../kube.js';
import { err, ok } from '../result.js';
import { jobsPass } from './loop.js';
import { planJobs } from './manifests.js';
import { reconcileJobs } from './reconcile.js';

const project = { id: '11111111-1111-4111-8111-111111111111', accountId: 'a', name: 'shop', createdAt: '2026-10-31T00:00:00Z' };
const namespace = `project-${project.id}`;
const digest = `sha256:${'c'.repeat(64)}`;
const jobId = '22222222-2222-4222-8222-222222222222';
const row = (overrides: Partial<JobRow['job']> = {}): JobRow => ({
    project,
    job: {
        id: jobId,
        name: 'nightly',
        image: 'ghcr.io/acme/api:v1',
        imageDigest: digest,
        command: ['node', 'dist/nightly.js'],
        args: null,
        memoryMb: 256,
        cpuMillicores: 250,
        timeoutSeconds: 600,
        schedule: '0 3 * * *',
        timeZone: 'Europe/Berlin',
        ...overrides,
    },
    pinnedImage: `ghcr.io/acme/api@${digest}`,
    site: 'ovh-lim',
});

interface CronJobSpec {
    schedule: string;
    suspend: boolean;
    timeZone: string;
    concurrencyPolicy: string;
    successfulJobsHistoryLimit: number;
    failedJobsHistoryLimit: number;
    jobTemplate: {
        metadata: { labels: Record<string, string> };
        spec: {
            backoffLimit: number;
            activeDeadlineSeconds: number;
            ttlSecondsAfterFinished: number;
            template: {
                metadata: { labels: Record<string, string> };
                spec: {
                    restartPolicy: string;
                    runtimeClassName: string;
                    automountServiceAccountToken: boolean;
                    imagePullSecrets: unknown;
                    affinity: { nodeAffinity: { preferredDuringSchedulingIgnoredDuringExecution: unknown } };
                    containers: { image: string; command?: string[]; args?: string[]; envFrom: unknown; resources: unknown }[];
                };
            };
        };
    };
}
const specOf = (object: KubeObject | undefined) => object?.['spec'] as CronJobSpec;
const cronJobOf = (rows: JobRow[]) => planJobs(rows).find((o) => o.kind === 'CronJob');

test("a Project's namespace and NetworkPolicies first, then each Job's CronJob", () => {
    const plan = planJobs([row(), row({ id: '33333333-3333-4333-8333-333333333333', name: 'once', schedule: null, timeZone: null })]);
    assert.deepEqual(
        plan.map((o) => `${o.kind} ${o.metadata.name}`),
        [
            `Namespace ${namespace}`,
            'NetworkPolicy project-isolation',
            'NetworkPolicy job-egress',
            `CronJob job-${jobId}`,
            'CronJob job-33333333-3333-4333-8333-333333333333',
        ],
    );
});

test('a Cron job runs on its schedule in its time zone, never overlapping, keeping 3 runs of each outcome', () => {
    const spec = specOf(cronJobOf([row()]));
    assert.equal(spec.schedule, '0 3 * * *');
    assert.equal(spec.suspend, false);
    assert.equal(spec.timeZone, 'Europe/Berlin');
    assert.equal(spec.concurrencyPolicy, 'Forbid');
    assert.deepEqual([spec.successfulJobsHistoryLimit, spec.failedJobsHistoryLimit], [3, 3]);
});

test('a Job without a schedule is a suspended template; time zones default to UTC', () => {
    const spec = specOf(cronJobOf([row({ schedule: null, timeZone: null })]));
    assert.equal(spec.suspend, true);
    assert.equal(spec.timeZone, 'Etc/UTC');
});

test('a run is one attempt under gVisor with the pinned image, its timeout, the Secrets and no API token, kept a day', () => {
    const job = specOf(cronJobOf([row({ args: ['--full'] })])).jobTemplate;
    assert.equal(job.spec.backoffLimit, 0);
    assert.equal(job.spec.activeDeadlineSeconds, 600);
    assert.equal(job.spec.ttlSecondsAfterFinished, 86400);
    const pod = job.spec.template.spec;
    assert.equal(pod.restartPolicy, 'Never');
    assert.equal(pod.runtimeClassName, 'gvisor');
    assert.equal(pod.automountServiceAccountToken, false);
    assert.deepEqual(pod.imagePullSecrets, [{ name: 'project-registry-auth' }]);
    const [container] = pod.containers;
    assert.equal(container?.image, `ghcr.io/acme/api@${digest}`);
    assert.deepEqual(container?.command, ['node', 'dist/nightly.js']);
    assert.deepEqual(container?.args, ['--full']);
    assert.deepEqual(container?.envFrom, [{ secretRef: { name: 'project-secrets' } }]);
    assert.deepEqual(container?.resources, { requests: { cpu: '250m', memory: '256Mi' }, limits: { cpu: '250m', memory: '256Mi' } });
    assert.deepEqual(pod.affinity.nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution, [
        { weight: 100, preference: { matchExpressions: [{ key: 'topology.kubernetes.io/zone', operator: 'In', values: ['ovh-lim'] }] } },
    ]);
    // Without a command or args of its own, the image's are kept.
    const plain = specOf(cronJobOf([row({ command: null })])).jobTemplate.spec.template.spec.containers[0];
    assert.equal(plain?.command, undefined);
    assert.equal(plain?.args, undefined);
});

test('runs carry the Job id the control plane lists them by, and the label the egress policy selects', () => {
    const job = specOf(cronJobOf([row()])).jobTemplate;
    for (const labels of [job.metadata.labels, job.spec.template.metadata.labels]) {
        assert.equal(labels['openupstream.io/job-id'], jobId);
        assert.equal(labels['openupstream.io/component'], 'jobs');
    }
    const egress = planJobs([row()]).find((o) => o.metadata.name === 'job-egress');
    assert.deepEqual((egress?.['spec'] as { podSelector: unknown }).podSelector, { matchLabels: { 'openupstream.io/component': 'jobs' } });
});

test('the CronJob carries the spec version the control plane compares its row with', () => {
    assert.equal(cronJobOf([row()])?.metadata.annotations?.['openupstream.io/spec-version'], jobSpecVersion(row()));
});

/** A cluster holding `existing` objects of ours; records applies and removes. */
const fakeKube = (existing: ObjectRef[]) => {
    const applied: string[] = [];
    const removed: string[] = [];
    const kube: Kube = {
        apply: async (object) => {
            applied.push(`${object.kind} ${object.metadata.name}`);
            return ok(undefined);
        },
        readSecret: async () => ok(undefined),
        list: async (apiVersion, kind) => ok(existing.filter((ref) => ref.apiVersion === apiVersion && ref.kind === kind)),
        remove: async (ref) => {
            removed.push(`${ref.kind} ${ref.name}`);
            return ok(undefined);
        },
    };
    return { kube, applied, removed };
};

test("a deleted Job's CronJob is removed; its runs are left to Kubernetes", async () => {
    const gone = 'job-99999999-9999-4999-8999-999999999999';
    const { kube, removed } = fakeKube([
        { apiVersion: 'batch/v1', kind: 'CronJob', namespace, name: gone },
        { apiVersion: 'batch/v1', kind: 'Job', namespace, name: `${gone}-abc123` },
    ]);
    const report = await reconcileJobs(kube, [row()]);
    assert.deepEqual(removed, [`CronJob ${gone}`]);
    assert.equal(report.failed.length, 0);
});

test('without the Jobs nothing is applied or deleted', async () => {
    const { kube, applied, removed } = fakeKube([{ apiVersion: 'batch/v1', kind: 'CronJob', namespace, name: 'job-x' }]);
    const log = await jobsPass(async () => err({ kind: 'unreachable', message: 'down' }), kube);
    assert.equal(log.msg, 'cannot get the Jobs');
    assert.deepEqual([applied, removed], [[], []]);
    const done = await jobsPass(async () => ok([row()]), kube);
    assert.equal(done['jobs'], 1);
});
