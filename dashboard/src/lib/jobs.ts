import { DNS_LABEL, SITE_ID, JOB_LIMITS, type Job, type JobInput, type JobPatch, type JobRun, type Site } from '@openupstream/sdk';
import { whole, within } from './usage';

/** What a Job form holds, as typed. `schedule` empty: started only by hand; `timeZone` empty: UTC; `homeSite` empty: wherever the Project's data is. */
export interface JobFields {
    readonly image: string;
    readonly schedule: string;
    readonly timeZone: string;
    readonly timeoutSeconds: string;
    readonly memoryMb: string;
    readonly cpuMillicores: string;
    readonly homeSite: string;
}

/** What the form means, with every field said: null where the Job has none. */
export interface JobWanted {
    readonly image: string;
    readonly schedule: string | null;
    readonly timeZone: string | null;
    readonly timeoutSeconds: number;
    readonly memoryMb: number;
    readonly cpuMillicores: number;
    readonly homeSite: Site | null;
}

export const NEW_JOB: JobFields = {
    image: '',
    schedule: '',
    timeZone: '',
    timeoutSeconds: String(JOB_LIMITS.defaultTimeoutSeconds),
    memoryMb: '256',
    cpuMillicores: '250',
    homeSite: '',
};

export const jobFieldsOf = (job: JobWanted): JobFields => ({
    image: job.image,
    schedule: job.schedule ?? '',
    timeZone: job.timeZone ?? '',
    timeoutSeconds: String(job.timeoutSeconds),
    memoryMb: String(job.memoryMb),
    cpuMillicores: String(job.cpuMillicores),
    homeSite: job.homeSite ?? '',
});

/** The fields as values; what is wrong with them otherwise. The API checks the same and more (the image, the schedule's syntax, the time zone). */
export const jobWanted = (fields: JobFields): JobWanted | string => {
    const image = fields.image.trim();
    const schedule = fields.schedule.trim() === '' ? null : fields.schedule.trim().replace(/\s+/g, ' ');
    const timeZone = fields.timeZone.trim() === '' ? null : fields.timeZone.trim();
    const timeoutSeconds = whole(fields.timeoutSeconds);
    const memoryMb = whole(fields.memoryMb);
    const cpuMillicores = whole(fields.cpuMillicores);
    const homeSite = fields.homeSite === '' ? null : SITE_ID.test(fields.homeSite) ? fields.homeSite : undefined;
    return image === '' || /\s/.test(image)
        ? 'Enter the image, e.g. ghcr.io/acme/report:v3.'
        : schedule !== null && !schedule.startsWith('@') && schedule.split(' ').length !== 5
          ? 'A schedule has five fields, e.g. 0 3 * * * for every day at 03:00, or is @hourly, @daily, @weekly, @monthly or @yearly.'
          : schedule === null && timeZone !== null
            ? 'A time zone is for a schedule: enter one, or leave the time zone empty.'
            : !within(timeoutSeconds, 1, JOB_LIMITS.maxTimeoutSeconds)
              ? `The timeout is a whole number of seconds from 1 to ${JOB_LIMITS.maxTimeoutSeconds} (a day).`
              : !within(memoryMb, JOB_LIMITS.minMemoryMb, JOB_LIMITS.maxMemoryMb)
                ? `Memory is a whole number of MB from ${JOB_LIMITS.minMemoryMb} to ${JOB_LIMITS.maxMemoryMb}.`
                : !within(cpuMillicores, JOB_LIMITS.minCpuMillicores, JOB_LIMITS.maxCpuMillicores)
                  ? `CPU is a whole number of millicores from ${JOB_LIMITS.minCpuMillicores} to ${JOB_LIMITS.maxCpuMillicores} (1000 is one CPU).`
                  : homeSite === undefined
                    ? 'Choose a Site from the list.'
                    : { image, schedule, timeZone, timeoutSeconds, memoryMb, cpuMillicores, homeSite };
};

/** What is wrong with a new Job's name; undefined when nothing is. */
export const jobNameProblem = (name: string, existing: readonly Pick<Job, 'name'>[]): string | undefined =>
    name === ''
        ? 'Enter a name.'
        : !DNS_LABEL.test(name)
          ? 'Lowercase letters, digits and hyphens, starting with a letter, at most 63 characters, e.g. nightly-report.'
          : existing.some((job) => job.name === name)
            ? `A Job named ${name} exists.`
            : undefined;

/** A new Job for the API, which runs the image's own command: no schedule, time zone or Site means none. */
export const jobInput = (name: string, wanted: JobWanted): JobInput => ({
    name,
    image: wanted.image,
    memoryMb: wanted.memoryMb,
    cpuMillicores: wanted.cpuMillicores,
    timeoutSeconds: wanted.timeoutSeconds,
    ...(wanted.schedule === null ? {} : { schedule: wanted.schedule }),
    ...(wanted.timeZone === null ? {} : { timeZone: wanted.timeZone }),
    ...(wanted.homeSite === null ? {} : { homeSite: wanted.homeSite }),
});

/** Only what differs from the Job, for the API; a problem when nothing does. */
export const jobPatch = (job: JobWanted, wanted: JobWanted): JobPatch | string => {
    const patch: JobPatch = {
        ...(wanted.image === job.image ? {} : { image: wanted.image }),
        ...(wanted.schedule === job.schedule ? {} : { schedule: wanted.schedule }),
        ...(wanted.timeZone === job.timeZone ? {} : { timeZone: wanted.timeZone }),
        ...(wanted.timeoutSeconds === job.timeoutSeconds ? {} : { timeoutSeconds: wanted.timeoutSeconds }),
        ...(wanted.memoryMb === job.memoryMb ? {} : { memoryMb: wanted.memoryMb }),
        ...(wanted.cpuMillicores === job.cpuMillicores ? {} : { cpuMillicores: wanted.cpuMillicores }),
        ...(wanted.homeSite === job.homeSite ? {} : { homeSite: wanted.homeSite }),
    };
    return Object.keys(patch).length === 0 ? 'Nothing is changed. To run what the tag points at from now on, use Redeploy.' : patch;
};

/** When a Job runs, in words. */
export const scheduleLabel = (job: Pick<Job, 'schedule' | 'timeZone'>): string =>
    job.schedule === null ? 'runs when started' : `runs at ${job.schedule} (${job.timeZone ?? 'UTC'}) and when started`;

/** Seconds as `45 s`, `12 min` or `3 h 5 min`. */
export const formatSeconds = (seconds: number): string => {
    const minutes = Math.round(seconds / 60);
    return seconds < 59.5 ? `${Math.round(seconds)} s` : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 === 0 ? '' : ` ${minutes % 60} min`}`;
};

/** How long a run took, or has taken until `now`; undefined before it started. */
export const runDuration = (run: Pick<JobRun, 'startedAt' | 'finishedAt'>, now: number): string | undefined =>
    run.startedAt === null ? undefined : formatSeconds(Math.max(0, ((run.finishedAt === null ? now : Date.parse(run.finishedAt)) - Date.parse(run.startedAt)) / 1000));
