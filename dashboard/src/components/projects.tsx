'use client';

import type { Account, ApiResult, OpenUpstreamClient, Project } from '@openupstream/sdk';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { projectNameProblem, projectsByAccount } from '../lib/projects';
import { api, refused } from '../lib/session';

type Loaded = { readonly accounts: readonly Account[]; readonly projects: readonly Project[] };

const load = async (client: OpenUpstreamClient): Promise<ApiResult<Loaded>> => {
    const [accounts, projects] = await Promise.all([client.listAccounts(), client.listProjects()]);
    return !accounts.ok ? accounts : !projects.ok ? projects : { ok: true, value: { accounts: accounts.value, projects: projects.value } };
};

/** The signed-in Member's Accounts and their Projects; the first visit creates an Account (decision 62). */
export function Projects() {
    const [loaded, setLoaded] = useState<Loaded | undefined>(undefined);
    const [problem, setProblem] = useState<string | undefined>(undefined);

    const refresh = useCallback(async () => {
        const result = await load(await api());
        setProblem(result.ok ? undefined : refused(result.error));
        if (result.ok) {
            setLoaded(result.value);
        }
    }, []);
    useEffect(() => void refresh(), [refresh]);

    /** Runs a change, then loads again; a refusal is shown instead. */
    const change = async (run: (client: OpenUpstreamClient) => Promise<ApiResult<unknown>>): Promise<boolean> => {
        const result = await run(await api());
        if (!result.ok) {
            setProblem(refused(result.error));
            return false;
        }
        await refresh();
        return true;
    };

    if (loaded === undefined) {
        return problem === undefined ? <p aria-busy="true">Loading…</p> : <p role="alert">{problem}</p>;
    }
    return (
        <>
            {problem !== undefined && <p role="alert">{problem}</p>}
            {loaded.accounts.length === 0 ? (
                <section>
                    <h1>Create your Account</h1>
                    <p>An Account pays for its Projects and receives one invoice. You become its first Member.</p>
                    <NameForm label="Account name" placeholder="Your name or company" submit="Create Account" onSubmit={(name) => change((client) => client.createAccount({ name }))} />
                </section>
            ) : (
                projectsByAccount(loaded.accounts, loaded.projects).map(({ account, projects }) => (
                    <section key={account.id}>
                        <h1>{account.name}</h1>
                        {account.holds.length > 0 && (
                            <p className="notice">
                                This Account cannot create Resources yet ({account.holds.join(', ')}). Projects are free and can be created now.
                            </p>
                        )}
                        <h2>Projects</h2>
                        {projects.length === 0 ? (
                            <p>No Projects yet. A Project holds the Databases, Buckets and Services of one environment, e.g. staging or production.</p>
                        ) : (
                            <ul className="projects">
                                {projects.map((project) => (
                                    <li key={project.id}>
                                        <span>
                                            <a href={`/project?id=${project.id}`}>
                                                <strong>{project.name}</strong>
                                            </a>
                                            <small>created {new Date(project.createdAt).toLocaleDateString()}</small>
                                        </span>
                                        <button
                                            type="button"
                                            className="link danger"
                                            onClick={() => {
                                                if (window.confirm(`Delete the Project ${project.name} and everything in it? This cannot be undone.`)) {
                                                    void change((client) => client.deleteProject(project.id));
                                                }
                                            }}
                                        >
                                            Delete
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                        <NameForm
                            label="New Project"
                            placeholder="production"
                            submit="Create Project"
                            check={(name) => projectNameProblem(name, projects)}
                            onSubmit={(name) => change((client) => client.createProject({ accountId: account.id, name }))}
                        />
                    </section>
                ))
            )}
        </>
    );
}

/** One text field and a button; cleared once `onSubmit` succeeded. */
function NameForm(props: {
    readonly label: string;
    readonly placeholder: string;
    readonly submit: string;
    readonly check?: (name: string) => string | undefined;
    readonly onSubmit: (name: string) => Promise<boolean>;
}) {
    const [name, setName] = useState('');
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const [busy, setBusy] = useState(false);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        const trimmed = name.trim();
        const found = trimmed === '' ? 'Enter a name.' : props.check?.(trimmed);
        setProblem(found);
        if (found !== undefined) {
            return;
        }
        setBusy(true);
        const done = await props.onSubmit(trimmed);
        setBusy(false);
        if (done) {
            setName('');
        }
    };
    return (
        <form onSubmit={(event) => void submit(event)}>
            <label>
                {props.label}
                <input value={name} placeholder={props.placeholder} maxLength={200} onChange={(event) => {
                        setName(event.target.value);
                        setProblem(undefined);
                    }} aria-invalid={problem !== undefined} />
            </label>
            <button type="submit" disabled={busy}>
                {props.submit}
            </button>
            {problem !== undefined && <small role="alert">{problem}</small>}
        </form>
    );
}
