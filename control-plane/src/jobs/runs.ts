/**
 * A Job's runs as Kubernetes Jobs (ARCHITECTURE.md, "Containers"; decision
 * 95, ADR-0003), as pure functions: the run the control plane starts for a
 * One-off job, copied from the `jobTemplate` of the Job's CronJob as
 * `kubectl create job --from=cronjob/…` does, and the JobRun the API
 * reports for any run, scheduled or started.
 *
 * A started run names the CronJob as its owner, so deleting the Job
 * deletes it, but not as its controller: the CronJob controller counts
 * only its own runs against the history limits and the overlap rule, so a
 * One-off job neither pushes out scheduled runs nor is pushed out by them.
 */
import { randomBytes } from 'node:crypto';
import { JOB_ID_LABEL, type JobRun, RUN_TRIGGER_LABEL, jobObjectName, projectNamespace } from '@openupstream/sdk';
import type { KubeJob } from '../kube.js';

/** A run's name: its CronJob's, then a suffix; Kubernetes names a scheduled run with the minute it was due. */
export const runName = (jobId: string, suffix: string = randomBytes(4).toString('hex')): string => `${jobObjectName({ id: jobId })}-${suffix}`;

/** Whether `runId` can name a run of the Job; anything else is not looked up. */
export const isRunOf = (jobId: string, runId: string): boolean =>
    runId.startsWith(`${jobObjectName({ id: jobId })}-`) && /^[a-z0-9]{1,16}$/.test(runId.slice(jobObjectName({ id: jobId }).length + 1));

/** What a One-off job changes in its run: the args for this run, and variables added to its environment. */
export interface RunOverrides {
    readonly args?: readonly string[] | undefined;
    readonly env?: Readonly<Record<string, string>> | undefined;
}

interface Container {
    readonly args?: readonly string[];
    readonly env?: readonly { readonly name: string; readonly value?: string }[];
    readonly [field: string]: unknown;
}

interface JobTemplate {
    readonly metadata?: { readonly labels?: Readonly<Record<string, string>>; readonly annotations?: Readonly<Record<string, string>> };
    readonly spec: {
        readonly template: { readonly spec: { readonly containers: readonly Container[]; readonly [field: string]: unknown }; readonly [field: string]: unknown };
        readonly [field: string]: unknown;
    };
}

const isJobTemplate = (value: unknown): value is JobTemplate => {
    const spec = (value as { spec?: { template?: { spec?: { containers?: unknown } } } } | undefined)?.spec;
    return Array.isArray(spec?.template?.spec?.containers) && spec.template.spec.containers.length > 0;
};

/**
 * The Kubernetes Job of a One-off job of `jobId`, from its CronJob's
 * template; undefined when the template is not one the Jobs operator
 * writes.
 */
export function runManifest(
    projectId: string,
    jobId: string,
    cronJob: { readonly uid: string; readonly jobTemplate: unknown },
    overrides: RunOverrides,
    name: string = runName(jobId),
): KubeJob | undefined {
    if (!isJobTemplate(cronJob.jobTemplate)) {
        return undefined;
    }
    const template = cronJob.jobTemplate;
    const [first, ...others] = template.spec.template.spec.containers;
    const container: Container = {
        ...first,
        ...(overrides.args === undefined ? {} : { args: overrides.args }),
        ...(overrides.env === undefined
            ? {}
            : { env: [...(first?.env ?? []), ...Object.entries(overrides.env).map(([key, value]) => ({ name: key, value }))] }),
    };
    return {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
            name,
            namespace: projectNamespace(projectId),
            labels: { ...template.metadata?.labels, [JOB_ID_LABEL]: jobId, [RUN_TRIGGER_LABEL]: 'api' },
            ...(template.metadata?.annotations === undefined ? {} : { annotations: { ...template.metadata.annotations } }),
            ownerReferences: [{ apiVersion: 'batch/v1', kind: 'CronJob', name: jobObjectName({ id: jobId }), uid: cronJob.uid }],
        },
        spec: { ...template.spec, template: { ...template.spec.template, spec: { ...template.spec.template.spec, containers: [container, ...others] } } },
    };
}

const timestamp = (value: Date | undefined): string | null => (value === undefined ? null : new Date(value).toISOString());

/** The run a Kubernetes Job of the Job's is, as the API reports it. */
export function runOf(job: KubeJob): JobRun {
    const conditions = job.status?.conditions ?? [];
    const holds = (type: string) => conditions.find((condition) => condition.type === type && condition.status === 'True');
    const complete = holds('Complete');
    const failed = holds('Failed');
    const base = {
        id: job.metadata.name,
        jobId: job.metadata.labels?.[JOB_ID_LABEL] ?? '',
        trigger: job.metadata.labels?.[RUN_TRIGGER_LABEL] === 'api' ? ('api' as const) : ('schedule' as const),
        createdAt: timestamp(job.metadata.creationTimestamp) ?? new Date(0).toISOString(),
        startedAt: timestamp(job.status?.startTime),
    };
    if (complete !== undefined) {
        return { ...base, state: 'succeeded', reason: null, finishedAt: timestamp(job.status?.completionTime ?? complete.lastTransitionTime) };
    }
    if (failed !== undefined) {
        return { ...base, state: 'failed', reason: failed.reason ?? null, finishedAt: timestamp(failed.lastTransitionTime) };
    }
    return { ...base, state: (job.status?.ready ?? 0) > 0 ? 'running' : 'pending', reason: null, finishedAt: null };
}

/** Newest first. */
export const byNewest = (a: JobRun, b: JobRun): number => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
