/**
 * `oup job`: Jobs and their runs (ARCHITECTURE.md, decision 95).
 *
 * `planJobDeploy` is pure and works like `planServiceDeploy`
 * (services.ts): no Job of that name → create it; one whose settings
 * differ from the flags → change it, with the image always in the change,
 * so its tag is resolved again; the same settings → deploy the tag again.
 * Flags left out keep what the Job has; on creation they take the defaults
 * below.
 */
import type { Job, JobDetails, JobInput, JobPatch, JobRun, RegistryAuth, Site } from '@openupstream/sdk';
import { DEFAULTS as SERVICE_DEFAULTS } from './services.js';
import { type Result, err, ok } from './result.js';

/** What a new Job gets for the flags left out; the timeout is the API's default. */
export const DEFAULTS = { memoryMb: SERVICE_DEFAULTS.memoryMb, cpuMillicores: SERVICE_DEFAULTS.cpuMillicores } as const;

/** What the flags ask for; `undefined`: keep what the Job has (or the default); `schedule: null`: none. */
export interface DesiredJob {
    readonly name: string;
    readonly image: string;
    /** null: the image's entrypoint again. */
    readonly command?: readonly string[] | null;
    readonly memoryMb?: number;
    readonly cpuMillicores?: number;
    readonly timeoutSeconds?: number;
    readonly schedule?: string | null;
    readonly timeZone?: string;
    readonly homeSite?: Site;
    readonly registryAuth?: RegistryAuth;
}

export type JobDeployPlan =
    | { readonly kind: 'create'; readonly input: JobInput }
    | { readonly kind: 'update'; readonly jobId: string; readonly patch: JobPatch }
    | { readonly kind: 'redeploy'; readonly jobId: string };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function planJobDeploy(existing: Job | undefined, desired: DesiredJob): JobDeployPlan {
    const { name, image, registryAuth, schedule, ...settings } = desired;
    if (existing === undefined) {
        return {
            kind: 'create',
            input: {
                name,
                image,
                memoryMb: settings.memoryMb ?? DEFAULTS.memoryMb,
                cpuMillicores: settings.cpuMillicores ?? DEFAULTS.cpuMillicores,
                ...(settings.command === undefined || settings.command === null ? {} : { command: [...settings.command] }),
                ...(settings.timeoutSeconds === undefined ? {} : { timeoutSeconds: settings.timeoutSeconds }),
                ...(schedule === undefined || schedule === null ? {} : { schedule }),
                ...(settings.timeZone === undefined ? {} : { timeZone: settings.timeZone }),
                ...(settings.homeSite === undefined ? {} : { homeSite: settings.homeSite }),
                ...(registryAuth === undefined ? {} : { registryAuth }),
            },
        };
    }
    const wanted: Partial<Record<keyof JobPatch, unknown>> = { ...settings, ...(schedule === undefined ? {} : { schedule }) };
    const changed = Object.entries(wanted).filter(
        ([key, value]) => value !== undefined && !same(existing[key as keyof Job], value),
    );
    if (changed.length === 0 && image === existing.image && registryAuth === undefined) {
        return { kind: 'redeploy', jobId: existing.id };
    }
    return {
        kind: 'update',
        jobId: existing.id,
        patch: { ...Object.fromEntries(changed), image, ...(registryAuth === undefined ? {} : { registryAuth }) } as JobPatch,
    };
}

/** `NAME=value` flags as the environment of a run; the API checks the names. */
export function parseEnv(pairs: readonly string[]): Result<Record<string, string>, string> {
    const entries: [string, string][] = [];
    for (const pair of pairs) {
        const at = pair.indexOf('=');
        if (at < 1) {
            return err(`--env takes NAME=value, not ${pair}`);
        }
        entries.push([pair.slice(0, at), pair.slice(at + 1)]);
    }
    return ok(Object.fromEntries(entries));
}

/** The flags each `oup job` verb takes; any other is refused rather than ignored. */
export const JOB_FLAGS = {
    list: ['project'],
    show: ['project'],
    runs: ['project'],
    stop: ['project'],
    delete: ['project'],
    deploy: [
        'project',
        'image',
        'schedule',
        'no-schedule',
        'time-zone',
        'timeout',
        'memory',
        'cpu',
        'site',
        'no-command',
        'registry-user',
        'registry-password-stdin',
        'no-wait',
    ],
    run: ['project', 'env', 'no-wait'],
} as const;

/** The first given flag the verb does not take; undefined when there is none. */
export const strayFlag = (verb: keyof typeof JOB_FLAGS, given: Readonly<Record<string, unknown>>): string | undefined =>
    Object.keys(given).find((flag) => given[flag] !== undefined && !(JOB_FLAGS[verb] as readonly string[]).includes(flag));

/** Splits arguments at the first `--`: what comes after is a command or args, never flags. */
export const splitAtDashes = (args: readonly string[]): { readonly flags: string[]; readonly rest: string[] | undefined } => {
    const at = args.indexOf('--');
    return at < 0 ? { flags: [...args], rest: undefined } : { flags: args.slice(0, at), rest: args.slice(at + 1) };
};

/** One line per Job: name, state, schedule (or `on demand`), image and the start of its digest. */
export const formatJobs = (jobs: readonly JobDetails[]): string[] =>
    jobs.map(
        (job) =>
            `${job.name.padEnd(24)} ${job.state.padEnd(10)} ${(job.schedule === null ? 'on demand' : `${job.schedule}${job.timeZone === null ? '' : ` ${job.timeZone}`}`).padEnd(28)} ${job.image} (${job.imageDigest.slice(0, 19)})`,
    );

const seconds = (from: string, to: string): string => `${Math.round((Date.parse(to) - Date.parse(from)) / 1000)} s`;

/** How a run ended, or that it has not yet. */
export const outcomeOf = (run: JobRun): string => {
    if (run.finishedAt === null) {
        return run.state;
    }
    const took = seconds(run.startedAt ?? run.createdAt, run.finishedAt);
    return run.state === 'succeeded' ? `succeeded in ${took}` : `failed after ${took}${run.reason === null ? '' : ` (${run.reason})`}`;
};

/** One line per run, newest first as the API lists them. */
export const formatRuns = (runs: readonly JobRun[]): string[] =>
    runs.map((run) => `${run.id.padEnd(52)} ${run.trigger.padEnd(9)} ${run.createdAt.padEnd(25)} ${outcomeOf(run)}`);

/** Whether the run has ended, either way. */
export const isFinished = (run: JobRun): boolean => run.state === 'succeeded' || run.state === 'failed';
