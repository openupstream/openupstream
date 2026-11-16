'use client';

import {
    type ApiResult,
    COMPUTE_SITES,
    type DatabaseDetails,
    type Instance,
    type Measured,
    type OpenUpstreamClient,
    type Project,
    type ProjectUsage,
    type ResourceKind,
    type ResourceUsage,
    type Site,
} from '@openupstream/sdk';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api, refused } from '../lib/session';
import { databaseNameProblem, databaseSizes, databaseUrlVariable, formatBytes, formatCpu, formatMeasured, resizeOf, usedShare } from '../lib/usage';

/** The Project, its Databases, and what its Resources use now; `usage` undefined when the API could not say. */
type Loaded = { readonly project: Project; readonly databases: readonly DatabaseDetails[]; readonly usage: ProjectUsage | undefined };

/** How often the page asks again while it is in front. */
const REFRESH_MS = 10_000;

const load = async (client: OpenUpstreamClient, id: string): Promise<ApiResult<Loaded>> => {
    const [project, databases, usage] = await Promise.all([client.getProject(id), client.listDatabases(id), client.getUsage(id)]);
    return !project.ok
        ? project
        : !databases.ok
          ? databases
          : { ok: true, value: { project: project.value, databases: databases.value, usage: usage.ok ? usage.value : undefined } };
};

const OTHER_KINDS: readonly { readonly kind: ResourceKind; readonly title: string; readonly command: string }[] = [
    { kind: 'service', title: 'Services', command: 'oup service deploy' },
    { kind: 'job', title: 'Jobs', command: 'oup job deploy' },
    { kind: 'bucket', title: 'Buckets', command: 'the API' },
];

/** One Project: its Databases, to create, resize and delete, and what every Resource uses now with its instances. */
export function ProjectPage({ id }: { readonly id: string }) {
    const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
    const [problem, setProblem] = useState<string | undefined>(undefined);

    // Answers can arrive out of order (a poll in flight while a change reloads): only the newest request's counts.
    const asked = useRef(0);
    const refresh = useCallback(async () => {
        const request = ++asked.current;
        const result = await load(await api(), id);
        if (request !== asked.current) {
            return;
        }
        setProblem(result.ok ? undefined : result.error.status === 404 ? 'This Project does not exist, or you are not a Member of its Account.' : refused(result.error));
        if (result.ok) {
            setLoaded(result.value);
        }
    }, [id]);
    useEffect(() => {
        void refresh();
        // Only while the page is looked at: a tab left open asks nothing.
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') {
                void refresh();
            }
        }, REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [refresh]);

    /** Runs a change, then loads again; what the API refused otherwise. */
    const change = async (run: (client: OpenUpstreamClient) => Promise<ApiResult<unknown>>): Promise<string | undefined> => {
        const result = await run(await api());
        if (!result.ok) {
            return refused(result.error);
        }
        await refresh();
        return undefined;
    };

    if (loaded === undefined) {
        return problem === undefined ? (
            <p aria-busy="true">Loading…</p>
        ) : (
            <p role="alert">
                {problem} <a href="/">To your Projects</a>
            </p>
        );
    }
    const { project, databases, usage } = loaded;
    const usageOf = (kind: ResourceKind, resourceId: string): ResourceUsage | undefined =>
        usage?.resources.find((resource) => resource.kind === kind && resource.id === resourceId);
    return (
        <>
            <p>
                <a href="/">← Projects</a>
            </p>
            <h1>{project.name}</h1>
            {problem !== undefined && <p role="alert">{problem}</p>}
            {usage === undefined ? (
                <p className="notice">What the Resources use cannot be read right now.</p>
            ) : (
                !usage.measured && <p className="notice">CPU, memory and disk are not measured right now: this installation's Prometheus did not answer, or it has none.</p>
            )}

            <section>
                <h2>Databases</h2>
                {databases.length === 0 ? (
                    <p>No Databases yet. A Database is Postgres with a standby in a second data centre, PgBouncer in front and continuous backups.</p>
                ) : (
                    <ul className="resources">
                        {databases.map((database) => (
                            <DatabaseCard
                                key={database.id}
                                database={database}
                                usage={usageOf('database', database.id)}
                                onResize={(patch) => change((client) => client.updateDatabase(project.id, database.id, patch))}
                                onDelete={() => change((client) => client.deleteDatabase(project.id, database.id))}
                            />
                        ))}
                    </ul>
                )}
                <DatabaseForm existing={databases} onCreate={(input) => change((client) => client.createDatabase(project.id, input))} />
            </section>

            {OTHER_KINDS.map(({ kind, title, command }) => {
                const resources = usage?.resources.filter((resource) => resource.kind === kind) ?? [];
                return (
                    <section key={kind}>
                        <h2>{title}</h2>
                        {resources.length === 0 ? (
                            <p>
                                <small>
                                    None. They are created with{' '}
                                    {command === 'the API' ? (
                                        command
                                    ) : (
                                        <a href="/cli">
                                            <code>{command}</code>
                                        </a>
                                    )}{' '}
                                    for now.
                                </small>
                            </p>
                        ) : (
                            <ul className="resources">
                                {resources.map((resource) => (
                                    <li key={resource.id}>
                                        <div className="resource-head">
                                            <strong>{resource.name}</strong>
                                        </div>
                                        <Usage usage={resource} />
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>
                );
            })}
        </>
    );
}

function DatabaseCard(props: {
    readonly database: DatabaseDetails;
    readonly usage: ResourceUsage | undefined;
    readonly onResize: (patch: { memoryMb?: number; storageGb?: number }) => Promise<string | undefined>;
    readonly onDelete: () => Promise<string | undefined>;
}) {
    const { database, usage } = props;
    const [resizing, setResizing] = useState(false);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const { connection } = database;
    return (
        <li>
            <div className="resource-head">
                <span>
                    <strong>{database.name}</strong> <span className={`state ${database.state}`}>{database.state}</span>
                </span>
                <span className="actions">
                    <button type="button" className="link" onClick={() => setResizing(!resizing)}>
                        {resizing ? 'Cancel' : 'Resize'}
                    </button>
                    <button
                        type="button"
                        className="link danger"
                        onClick={() => {
                            if (window.confirm(`Delete the Database ${database.name} and its data? Its backups are kept for the retention time.`)) {
                                void props.onDelete().then(setProblem);
                            }
                        }}
                    >
                        Delete
                    </button>
                </span>
            </div>
            <small>
                {database.memoryMb} MB memory, {database.storageGb} GB storage
                {database.autoGrow ? (database.maxStorageGb === null ? ', grows by itself' : `, grows by itself up to ${database.maxStorageGb} GB`) : ''}, primary in {database.homeSite}
            </small>
            {problem !== undefined && <p role="alert">{problem}</p>}
            {resizing && (
                <SizesForm
                    memoryMb={String(database.memoryMb)}
                    storageGb={String(database.storageGb)}
                    submit="Resize"
                    note="A new memory size restarts the instances one after the other; writes pause for seconds. Storage only grows."
                    onSubmit={async (sizes) => {
                        const patch = resizeOf(database, sizes);
                        if (typeof patch === 'string') {
                            return patch;
                        }
                        const refusal = await props.onResize(patch);
                        if (refusal === undefined) {
                            setResizing(false);
                        }
                        return refusal;
                    }}
                />
            )}
            {usage !== undefined && <Usage usage={usage} />}
            <details>
                <summary>Connection</summary>
                <dl>
                    <dt>Host</dt>
                    <dd>
                        <code>{connection.host}</code>
                    </dd>
                    <dt>Port</dt>
                    <dd>
                        <code>{connection.port}</code>
                    </dd>
                    <dt>Database</dt>
                    <dd>
                        <code>{connection.database}</code>
                    </dd>
                    <dt>User</dt>
                    <dd>
                        <code>{connection.user}</code>
                    </dd>
                </dl>
                <small>
                    Reached from this Project's Services and Jobs only, which get the whole URL with the password as <code>{databaseUrlVariable(database.name)}</code>.
                </small>
            </details>
        </li>
    );
}

/** A Resource's CPU, memory and storage against what it was given, then its instances. */
function Usage({ usage }: { readonly usage: ResourceUsage }) {
    return (
        <>
            <div className="meters">
                <Meter label="CPU" measured={usage.cpuMillicores} format={formatCpu} />
                <Meter label="Memory" measured={usage.memoryBytes} format={formatBytes} />
                <Meter label="Storage" measured={usage.storageBytes} format={formatBytes} />
            </div>
            {usage.instances.length > 0 && (
                <table>
                    <thead>
                        <tr>
                            <th>Instance</th>
                            <th>Site</th>
                            <th>State</th>
                            <th>CPU</th>
                            <th>Memory</th>
                            <th>Disk</th>
                        </tr>
                    </thead>
                    <tbody>
                        {usage.instances.map((instance) => (
                            <InstanceRow key={instance.name} instance={instance} />
                        ))}
                    </tbody>
                </table>
            )}
        </>
    );
}

const ROLE: Readonly<Record<Instance['role'], string>> = { database: 'Postgres', pooler: 'PgBouncer', replica: 'replica', run: 'run' };

function InstanceRow({ instance }: { readonly instance: Instance }) {
    const value = (measured: number | null, format: (value: number) => string) => (measured === null ? '–' : format(measured));
    return (
        <tr>
            <td>
                {ROLE[instance.role]} <code>{instance.name}</code>
            </td>
            <td>{instance.site ?? '–'}</td>
            <td>
                <span className={`state ${instance.state}`}>{instance.state}</span>
                {instance.restarts > 0 && <small> {instance.restarts} restarts</small>}
            </td>
            <td>{value(instance.cpuMillicores, formatCpu)}</td>
            <td>{value(instance.memoryBytes, formatBytes)}</td>
            <td>{value(instance.storageBytes, formatBytes)}</td>
        </tr>
    );
}

/** One figure with a bar when both what is used and what was given are known; nothing when neither is. */
function Meter(props: { readonly label: string; readonly measured: Measured; readonly format: (value: number) => string }) {
    const text = formatMeasured(props.measured, props.format);
    const share = usedShare(props.measured);
    return text === undefined ? null : (
        <div className="meter">
            <small>{props.label}</small>
            <span>{text}</span>
            {share !== undefined && (
                <div className="bar" role="meter" aria-label={props.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
                    <div className={share >= 0.9 ? 'full' : undefined} style={{ width: `${Math.max(1, share * 100)}%` }} />
                </div>
            )}
        </div>
    );
}

function DatabaseForm(props: {
    readonly existing: readonly DatabaseDetails[];
    readonly onCreate: (input: { name: string; memoryMb: number; storageGb: number; homeSite: Site }) => Promise<string | undefined>;
}) {
    const [name, setName] = useState('');
    const [homeSite, setHomeSite] = useState<Site>(COMPUTE_SITES[0]);
    return (
        <>
            <h3>New Database</h3>
            <SizesForm
                memoryMb="512"
                storageGb="10"
                submit="Create Database"
                resetOn={`${name} ${homeSite}`}
                onSubmit={async (sizes) => {
                    const trimmed = name.trim();
                    const found = trimmed === '' ? 'Enter a name.' : databaseNameProblem(trimmed, props.existing);
                    if (found !== undefined) {
                        return found;
                    }
                    const refusal = await props.onCreate({ name: trimmed, ...sizes, homeSite });
                    if (refusal === undefined) {
                        setName('');
                    }
                    return refusal;
                }}
            >
                <label>
                    Name
                    <input value={name} placeholder="main" maxLength={63} onChange={(event) => setName(event.target.value)} />
                </label>
                <label>
                    Primary in
                    <select value={homeSite} onChange={(event) => setHomeSite(COMPUTE_SITES.find((site) => site === event.target.value) ?? COMPUTE_SITES[0])}>
                        {COMPUTE_SITES.map((site) => (
                            <option key={site}>{site}</option>
                        ))}
                    </select>
                </label>
            </SizesForm>
        </>
    );
}

/** Memory and storage fields with a button; `children` are further fields in front. Shows what `onSubmit` returns. */
function SizesForm(props: {
    readonly memoryMb: string;
    readonly storageGb: string;
    readonly submit: string;
    readonly note?: string;
    /** The further fields' values: a change of them takes the message away, as a change of the sizes does. */
    readonly resetOn?: string;
    readonly children?: React.ReactNode;
    readonly onSubmit: (sizes: { memoryMb: number; storageGb: number }) => Promise<string | undefined>;
}) {
    const [memoryMb, setMemoryMb] = useState(props.memoryMb);
    const [storageGb, setStorageGb] = useState(props.storageGb);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    // What was wrong is about what was typed then, not about what is typed now.
    useEffect(() => setProblem(undefined), [memoryMb, storageGb, props.resetOn]);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        const sizes = databaseSizes(memoryMb, storageGb);
        if (typeof sizes === 'string') {
            setProblem(sizes);
            return;
        }
        setBusy(true);
        setProblem(await props.onSubmit(sizes));
        setBusy(false);
    };
    return (
        <form onSubmit={(event) => void submit(event)}>
            {props.children}
            <label>
                Memory (MB)
                <input value={memoryMb} inputMode="numeric" onChange={(event) => setMemoryMb(event.target.value)} />
            </label>
            <label>
                Storage (GB)
                <input value={storageGb} inputMode="numeric" onChange={(event) => setStorageGb(event.target.value)} />
            </label>
            <button type="submit" disabled={busy}>
                {props.submit}
            </button>
            {props.note !== undefined && <small>{props.note}</small>}
            {problem !== undefined && <small role="alert">{problem}</small>}
        </form>
    );
}
