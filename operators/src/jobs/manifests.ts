/**
 * A Project's Jobs as Kubernetes objects (ARCHITECTURE.md, "Containers";
 * decision 95, ADR-0003), as a pure function of the control plane's rows.
 *
 * Per Project with Jobs, in its namespace: the namespace and its
 * NetworkPolicy, then `job-egress`, the same egress a Service's pods get.
 * Per Job: a CronJob `job-<id>`. With a schedule it starts the runs of a
 * Cron job; without one it is suspended and only holds the template the
 * control plane copies when it starts a One-off job. Either way it is the
 * owner of its runs, so deleting it deletes them.
 *
 * Every run is one pod under the `gvisor` RuntimeClass with the image
 * pinned by digest, never retried, stopped at the Job's timeout and kept
 * 24 hours after it finished. Its pod prefers the Job's Site and goes to
 * the other one when that one is down.
 */
import { JOB_ID_LABEL, PROJECT_REGISTRY_AUTH, PROJECT_SECRETS, SPEC_VERSION_ANNOTATION, type JobRow, jobObjectName, jobSpecVersion } from '@openupstream/sdk';
import type { KubeObject } from '../kube.js';
import {
    COMPONENT_LABEL,
    LABELS,
    MANAGED_BY,
    ZONE_LABEL,
    customerEgressPolicy,
    projectNamespace,
    projectObjectsFor,
    requireComputeSite,
} from '../kubernetes.js';
import { RUNTIME_CLASS } from '../services/manifests.js';

export const JOBS_COMPONENT = 'jobs';
export const JOB_NAME_LABEL = 'openupstream.io/job-name';

/** How long a finished run, and its pod with its logs, stays. */
export const FINISHED_RUN_TTL_SECONDS = 24 * 60 * 60;
/** Scheduled runs a Cron job keeps, of each outcome. */
export const RUN_HISTORY = 3;
/**
 * A scheduled run more than this late (the controller was down) is skipped,
 * so a Cron job does not catch up on everything it missed at once.
 */
export const STARTING_DEADLINE_SECONDS = 300;
/** The schedule of a CronJob that never starts anything itself (`suspend`); any valid one would do. */
export const UNSCHEDULED = '@yearly';

/** The kinds this operator prunes. Runs are not among them: Kubernetes deletes them with their CronJob. */
export const PRUNED_KINDS = [
    { apiVersion: 'batch/v1', kind: 'CronJob' },
    { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy' },
] as const;

const labels = (projectId: string) => ({
    [LABELS.projectId]: projectId,
    [LABELS.managedBy]: MANAGED_BY,
    [COMPONENT_LABEL]: JOBS_COMPONENT,
});

const cronJob = (row: JobRow): KubeObject => {
    const { project, job } = row;
    const runLabels = { ...labels(project.id), [JOB_ID_LABEL]: job.id, [JOB_NAME_LABEL]: job.name };
    const resources = { cpu: `${job.cpuMillicores}m`, memory: `${job.memoryMb}Mi` };
    return {
        apiVersion: 'batch/v1',
        kind: 'CronJob',
        metadata: {
            name: jobObjectName(job),
            namespace: projectNamespace(project.id),
            labels: runLabels,
            // What the control plane compares with the row before it starts a run from this template.
            annotations: { [SPEC_VERSION_ANNOTATION]: jobSpecVersion(row) },
        },
        spec: {
            schedule: job.schedule ?? UNSCHEDULED,
            suspend: job.schedule === null,
            timeZone: job.timeZone ?? 'Etc/UTC',
            // A run that is due while the last one still runs is skipped.
            concurrencyPolicy: 'Forbid',
            startingDeadlineSeconds: STARTING_DEADLINE_SECONDS,
            successfulJobsHistoryLimit: RUN_HISTORY,
            failedJobsHistoryLimit: RUN_HISTORY,
            jobTemplate: {
                metadata: { labels: runLabels },
                spec: {
                    // One attempt: a retried run could repeat a side effect the customer's code already made.
                    backoffLimit: 0,
                    activeDeadlineSeconds: job.timeoutSeconds,
                    ttlSecondsAfterFinished: FINISHED_RUN_TTL_SECONDS,
                    template: {
                        metadata: { labels: runLabels },
                        spec: {
                            restartPolicy: 'Never',
                            runtimeClassName: RUNTIME_CLASS,
                            automountServiceAccountToken: false,
                            enableServiceLinks: false,
                            imagePullSecrets: [{ name: PROJECT_REGISTRY_AUTH }],
                            affinity: {
                                nodeAffinity: {
                                    requiredDuringSchedulingIgnoredDuringExecution: requireComputeSite(),
                                    preferredDuringSchedulingIgnoredDuringExecution: [
                                        { weight: 100, preference: { matchExpressions: [{ key: ZONE_LABEL, operator: 'In', values: [row.site] }] } },
                                    ],
                                },
                            },
                            containers: [
                                {
                                    name: 'job',
                                    image: row.pinnedImage,
                                    ...(job.command === null ? {} : { command: job.command }),
                                    ...(job.args === null ? {} : { args: job.args }),
                                    envFrom: [{ secretRef: { name: PROJECT_SECRETS } }],
                                    // As for a Service: the limits are what is reserved and billed.
                                    resources: { requests: resources, limits: resources },
                                    securityContext: { allowPrivilegeEscalation: false },
                                },
                            ],
                        },
                    },
                },
            },
        },
    };
};

/** Applied in this order, per Project: its namespace, NetworkPolicies, then each Job's CronJob. */
export function planJobs(rows: readonly JobRow[]): KubeObject[] {
    const projects = [...new Map(rows.map((row) => [row.project.id, row.project])).values()];
    return [
        ...projects.flatMap((project) => [
            ...projectObjectsFor(project),
            customerEgressPolicy(project.id, 'job-egress', JOBS_COMPONENT, labels(project.id)),
        ]),
        ...rows.map(cronJob),
    ];
}
