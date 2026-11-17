'use client';

import { COMPUTE_SITES, type JobDetails, type JobInput, type JobPatch, type JobRun, type ResourceUsage } from '@openupstream/sdk';
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { NEW_JOB, type JobFields, type JobWanted, jobFieldsOf, jobInput, jobNameProblem, jobPatch, jobWanted, formatSeconds, runDuration, scheduleLabel } from '../lib/jobs';
import { shortDigest } from '../lib/services';
import { api, refused } from '../lib/session';
import { Usage } from './usage';

/** What a change answers: undefined when it was done, what the API refused otherwise. */
type Change = Promise<string | undefined>;

/** How often an open list of runs asks again. */
const RUNS_REFRESH_MS = 5_000;

/** A Job: what it runs and when, its state and runs, and the ways to change it. */
export function JobCard(props: {
    readonly job: JobDetails;
    readonly usage: ResourceUsage | undefined;
    readonly onChange: (patch: JobPatch) => Change;
    readonly onRedeploy: () => Change;
    readonly onRun: () => Change;
    readonly onDelete: () => Change;
}) {
    const { job, usage } = props;
    const [changing, setChanging] = useState(false);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    // Counts the runs started here, so the list of runs opens and asks again.
    const [started, setStarted] = useState(0);
    const act = async (run: () => Change): Promise<boolean> => {
        setBusy(true);
        const refusal = await run();
        setProblem(refusal);
        setBusy(false);
        return refusal === undefined;
    };
    return (
        <li>
            <div className="resource-head">
                <span>
                    <strong>{job.name}</strong> <span className={`state ${job.state}`}>{job.state}</span>
                </span>
                <span className="actions">
                    <button type="button" className="link" disabled={busy} title="Starts a run now, with the Job's own command and arguments" onClick={() => void act(props.onRun).then((done) => done && setStarted(started + 1))}>
                        Run now
                    </button>
                    <button type="button" className="link" onClick={() => setChanging(!changing)}>
                        {changing ? 'Cancel' : 'Change'}
                    </button>
                    <button type="button" className="link" disabled={busy} title="Later runs start what the image's tag points at now" onClick={() => void act(props.onRedeploy)}>
                        Redeploy
                    </button>
                    <button
                        type="button"
                        className="link danger"
                        disabled={busy}
                        onClick={() => {
                            if (window.confirm(`Delete the Job ${job.name}? Its runs, running ones included, are stopped and removed.`)) {
                                void act(props.onDelete);
                            }
                        }}
                    >
                        Delete
                    </button>
                </span>
            </div>
            <small>
                <code>{job.image}</code> at <code>{shortDigest(job.imageDigest)}</code>, deployed {new Date(job.deployedAt).toLocaleString()}
                <br />
                {scheduleLabel(job)}, {job.memoryMb} MB memory and {job.cpuMillicores} millicores, stopped after {formatSeconds(job.timeoutSeconds)}
                {job.homeSite !== null && `, in ${job.homeSite}`}
                {job.registryAuth && ', pulled with registry credentials'}
                {(job.command !== null || job.args !== null) && (
                    <>
                        <br />
                        runs <code>{[...(job.command ?? ['(the image’s entrypoint)']), ...(job.args ?? [])].join(' ')}</code>
                    </>
                )}
            </small>
            {problem !== undefined && <p role="alert">{problem}</p>}
            {changing && (
                <FieldsForm
                    initial={jobFieldsOf(job)}
                    submit="Save"
                    note={
                        <>
                            Later runs get the change; a running one goes on as it is. A new image resolves its tag again. The command is changed with <a href="/cli">oup job deploy</a>.
                        </>
                    }
                    onSubmit={async (wanted) => {
                        const patch = jobPatch(job, wanted);
                        if (typeof patch === 'string') {
                            return patch;
                        }
                        const refusal = await props.onChange(patch);
                        if (refusal === undefined) {
                            setChanging(false);
                        }
                        return refusal;
                    }}
                />
            )}
            {usage !== undefined && <Usage usage={usage} />}
            <Runs key={started} projectId={job.projectId} jobId={job.id} open={started > 0} />
        </li>
    );
}

/** A Job's runs of the last day, read only while the list is open. */
function Runs(props: { readonly projectId: string; readonly jobId: string; readonly open: boolean }) {
    const { projectId, jobId } = props;
    const [open, setOpen] = useState(props.open);
    const [runs, setRuns] = useState<readonly JobRun[] | undefined>(undefined);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const load = useCallback(async () => {
        const result = await (await api()).listJobRuns(projectId, jobId);
        setProblem(result.ok ? undefined : refused(result.error));
        if (result.ok) {
            setRuns(result.value);
        }
    }, [projectId, jobId]);
    useEffect(() => {
        if (!open) {
            return undefined;
        }
        void load();
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') {
                void load();
            }
        }, RUNS_REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [open, load]);
    const stop = async (run: JobRun) => {
        const result = await (await api()).deleteJobRun(projectId, jobId, run.id);
        setProblem(result.ok ? undefined : refused(result.error));
        await load();
    };
    return (
        <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
            <summary>Runs</summary>
            {problem !== undefined && <p role="alert">{problem}</p>}
            {runs === undefined ? (
                problem === undefined && <small aria-busy="true">Loading…</small>
            ) : runs.length === 0 ? (
                <small>No runs in the last day.</small>
            ) : (
                <table>
                    <thead>
                        <tr>
                            <th>Started</th>
                            <th>By</th>
                            <th>State</th>
                            <th>Took</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {runs.map((run) => (
                            <tr key={run.id}>
                                <td>{new Date(run.startedAt ?? run.createdAt).toLocaleString()}</td>
                                <td>{run.trigger === 'schedule' ? 'schedule' : 'hand'}</td>
                                <td>
                                    <span className={`state ${run.state}`}>{run.state}</span>
                                    {run.reason !== null && <small> {run.reason === 'DeadlineExceeded' ? 'stopped at the timeout' : run.reason === 'BackoffLimitExceeded' ? 'exited with an error' : run.reason}</small>}
                                </td>
                                <td>{runDuration(run, Date.now()) ?? '–'}</td>
                                <td>
                                    <button
                                        type="button"
                                        className="link danger"
                                        onClick={() => {
                                            const going = run.state === 'pending' || run.state === 'running';
                                            if (window.confirm(going ? 'Stop this run and remove it?' : 'Remove this run from the list?')) {
                                                void stop(run);
                                            }
                                        }}
                                    >
                                        {run.state === 'pending' || run.state === 'running' ? 'Stop' : 'Remove'}
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            <small>
                A run&apos;s output is read with <a href="/cli">oup job logs</a>. Runs are kept a day.
            </small>
        </details>
    );
}

export function JobForm(props: { readonly existing: readonly JobDetails[]; readonly onCreate: (input: JobInput) => Change }) {
    const [name, setName] = useState('');
    // A new form after each Job, so its fields start over.
    const [created, setCreated] = useState(0);
    return (
        <>
            <h3>New Job</h3>
            <FieldsForm
                key={created}
                initial={NEW_JOB}
                submit="Deploy Job"
                resetOn={name}
                note={
                    <>
                        The Job runs the image&apos;s own command, and the image must be public: another command, or an image from a private registry, is given to{' '}
                        <a href="/cli">oup job deploy</a>.
                    </>
                }
                onSubmit={async (wanted) => {
                    const trimmed = name.trim();
                    const found = jobNameProblem(trimmed, props.existing);
                    if (found !== undefined) {
                        return found;
                    }
                    const refusal = await props.onCreate(jobInput(trimmed, wanted));
                    if (refusal === undefined) {
                        setName('');
                        setCreated(created + 1);
                    }
                    return refusal;
                }}
            >
                <label>
                    Name
                    <input value={name} placeholder="nightly-report" maxLength={63} onChange={(event) => setName(event.target.value)} />
                </label>
            </FieldsForm>
        </>
    );
}

/** A Job's fields with a button; `children` are further fields in front. Shows what `onSubmit` returns. */
function FieldsForm(props: {
    readonly initial: JobFields;
    readonly submit: string;
    readonly note: ReactNode;
    /** The further fields' values: a change of them takes the message away, as a change of these fields does. */
    readonly resetOn?: string;
    readonly children?: ReactNode;
    readonly onSubmit: (wanted: JobWanted) => Change;
}) {
    const [fields, setFields] = useState(props.initial);
    const [busy, setBusy] = useState(false);
    // What was wrong is about what was typed then: kept with it, and gone once anything differs.
    const [problem, setProblem] = useState<{ readonly text: string; readonly about: string } | undefined>(undefined);
    const typed = JSON.stringify([fields, props.resetOn]);
    const set = (field: keyof JobFields) => (event: { readonly target: { readonly value: string } }) => setFields({ ...fields, [field]: event.target.value });
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        const wanted = jobWanted(fields);
        if (typeof wanted === 'string') {
            setProblem({ text: wanted, about: typed });
            return;
        }
        setBusy(true);
        const refusal = await props.onSubmit(wanted);
        setProblem(refusal === undefined ? undefined : { text: refusal, about: typed });
        setBusy(false);
    };
    return (
        <form onSubmit={(event) => void submit(event)}>
            {props.children}
            <label>
                Image
                <input value={fields.image} placeholder="ghcr.io/acme/report:v3" onChange={set('image')} />
            </label>
            <label>
                Schedule (empty: only when started)
                <input value={fields.schedule} placeholder="0 3 * * *" onChange={set('schedule')} />
            </label>
            <label>
                Time zone (empty: UTC)
                <input value={fields.timeZone} placeholder="Europe/Berlin" onChange={set('timeZone')} />
            </label>
            <label>
                Timeout (seconds)
                <input value={fields.timeoutSeconds} inputMode="numeric" onChange={set('timeoutSeconds')} />
            </label>
            <label>
                Memory (MB)
                <input value={fields.memoryMb} inputMode="numeric" onChange={set('memoryMb')} />
            </label>
            <label>
                CPU (millicores)
                <input value={fields.cpuMillicores} inputMode="numeric" onChange={set('cpuMillicores')} />
            </label>
            <label>
                Site
                <select value={fields.homeSite} onChange={set('homeSite')}>
                    <option value="">Where the Project&apos;s data is</option>
                    {COMPUTE_SITES.map((site) => (
                        <option key={site}>{site}</option>
                    ))}
                </select>
            </label>
            <button type="submit" disabled={busy}>
                {busy ? 'Working…' : props.submit}
            </button>
            <small>{props.note}</small>
            {problem !== undefined && problem.about === typed && <small role="alert">{problem.text}</small>}
        </form>
    );
}
