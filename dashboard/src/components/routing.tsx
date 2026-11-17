'use client';

import type { Bucket, BucketInput, CustomDomainInput, Domain, ResourceUsage, Route, RouteInput } from '@openupstream/sdk';
import { type FormEvent, type ReactNode, useState } from 'react';
import { NEW_ROUTE, type Targets, bucketEndpoint, bucketNameProblem, hostnameOf, hostnameProblem, ingressOf, routeInput, targetLabel, targetOptions } from '../lib/routing';
import { Usage } from './usage';

/** What a change answers: undefined when it was done, what the API refused otherwise. */
type Change = Promise<string | undefined>;

/** A message about what was typed then: shown only while `about` is still what is typed. */
type Problem = { readonly text: string; readonly about: string } | undefined;

/** One text field with a button; shows what `onSubmit` returns, until the text changes. Empties itself when it was done. */
function OneFieldForm(props: {
    readonly label: string;
    readonly placeholder: string;
    readonly submit: string;
    readonly note?: ReactNode;
    readonly onSubmit: (typed: string) => Change;
}) {
    const [typed, setTyped] = useState('');
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<Problem>(undefined);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        const refusal = await props.onSubmit(typed);
        setProblem(refusal === undefined ? undefined : { text: refusal, about: typed });
        if (refusal === undefined) {
            setTyped('');
        }
        setBusy(false);
    };
    return (
        <form onSubmit={(event) => void submit(event)}>
            <label>
                {props.label}
                <input value={typed} placeholder={props.placeholder} maxLength={253} onChange={(event) => setTyped(event.target.value)} />
            </label>
            <button type="submit" disabled={busy}>
                {busy ? 'Working…' : props.submit}
            </button>
            {props.note !== undefined && <small>{props.note}</small>}
            {problem !== undefined && problem.about === typed && <small role="alert">{problem.text}</small>}
        </form>
    );
}

const Links = ({ urls }: { readonly urls: readonly string[] }) =>
    urls.map((url, index) => (
        <span key={url}>
            {index > 0 && ', '}
            <a href={url} target="_blank" rel="noreferrer">
                {url.replace(/^https:\/\//, '')}
            </a>
        </span>
    ));

/** A Bucket: where S3 clients reach it, where it is served, what it holds, and its deletion. Its key is not shown (decision 128). */
export function BucketCard(props: {
    readonly bucket: Bucket;
    readonly usage: ResourceUsage | undefined;
    /** The Project's default Domain's hostname, which says where Buckets are reached; undefined when the Domains could not say. */
    readonly defaultHostname: string | undefined;
    readonly servedAt: readonly string[];
    readonly onDelete: () => Change;
}) {
    const { bucket, usage, defaultHostname, servedAt } = props;
    const [busy, setBusy] = useState(false);
    // A refusal is about the Routes there were then: gone once they differ.
    const [problem, setProblem] = useState<Problem>(undefined);
    const about = servedAt.join(' ');
    return (
        <li>
            <div className="resource-head">
                <strong>{bucket.name}</strong>
                <span className="actions">
                    <button
                        type="button"
                        className="link danger"
                        disabled={busy}
                        onClick={() => {
                            if (window.confirm(`Delete the Bucket ${bucket.name} and every object in it? Nothing is kept.`)) {
                                setBusy(true);
                                void props.onDelete().then((refusal) => {
                                    setProblem(refusal === undefined ? undefined : { text: refusal, about });
                                    setBusy(false);
                                });
                            }
                        }}
                    >
                        Delete
                    </button>
                </span>
            </div>
            <small>
                {defaultHostname !== undefined && (
                    <>
                        S3 endpoint <code>{bucketEndpoint(bucket.name, defaultHostname)}</code>
                        <br />
                    </>
                )}
                {servedAt.length === 0 ? 'Not served: no Route goes to it.' : (
                    <>
                        Served at <Links urls={servedAt} />
                    </>
                )}
            </small>
            {problem !== undefined && problem.about === about && <p role="alert">{problem.text}</p>}
            {usage !== undefined && <Usage usage={usage} />}
        </li>
    );
}

export function BucketForm(props: { readonly existing: readonly Bucket[]; readonly onCreate: (input: BucketInput) => Change }) {
    return (
        <>
            <h3>New Bucket</h3>
            <OneFieldForm
                label="Name"
                placeholder="acme-site"
                submit="Create Bucket"
                note={
                    <>
                        The name is part of the Bucket&apos;s hostname, so no other Bucket of anyone has it. Files are uploaded with <a href="/cli">oup site deploy</a> or any S3 client; the
                        Bucket&apos;s key comes from <a href="/cli">oup bucket export-env</a>, not from this page.
                    </>
                }
                onSubmit={async (typed) => {
                    const name = typed.trim();
                    return bucketNameProblem(name, props.existing) ?? (await props.onCreate({ name }));
                }}
            />
        </>
    );
}

/** A Domain: its hostname, for a custom one its proof of ownership, and its Routes. */
export function DomainCard(props: {
    readonly domain: Domain;
    readonly routes: readonly Route[];
    /** The Routes of every Domain of the Project. */
    readonly allRoutes: readonly Route[];
    readonly targets: Targets;
    /** Where a custom domain's CNAME points; undefined when the page does not know. */
    readonly ingress: string | undefined;
    readonly onVerify: () => Change;
    readonly onDelete: () => Change;
    readonly onCreateRoute: (input: RouteInput) => Change;
    readonly onDeleteRoute: (route: Route) => Change;
}) {
    const { domain, routes, targets } = props;
    const [adding, setAdding] = useState(false);
    const [busy, setBusy] = useState(false);
    const pending = domain.kind === 'custom' && domain.verification.state === 'pending' ? domain.verification.txtRecord : undefined;
    // A refusal is about the Domain as it was then: gone once its Routes or its verification differ.
    const [problem, setProblem] = useState<Problem>(undefined);
    const about = JSON.stringify([routes.map((route) => route.id), pending === undefined]);
    const act = async (run: () => Change) => {
        setBusy(true);
        const refusal = await run();
        setProblem(refusal === undefined ? undefined : { text: refusal, about });
        setBusy(false);
    };
    return (
        <li>
            <div className="resource-head">
                <span>
                    <strong>
                        {pending === undefined ? (
                            <a href={`https://${domain.hostname}`} target="_blank" rel="noreferrer">
                                {domain.hostname}
                            </a>
                        ) : (
                            domain.hostname
                        )}
                    </strong>{' '}
                    <span className={`state ${pending === undefined ? 'ready' : 'pending'}`}>{domain.kind === 'default' ? 'default' : pending === undefined ? 'verified' : 'not verified'}</span>
                </span>
                <span className="actions">
                    <button type="button" className="link" onClick={() => setAdding(!adding)}>
                        {adding ? 'Cancel' : 'Add Route'}
                    </button>
                    {domain.kind === 'custom' && (
                        <button
                            type="button"
                            className="link danger"
                            disabled={busy}
                            onClick={() => {
                                if (window.confirm(`Delete the Domain ${domain.hostname} and its Routes?`)) {
                                    void act(props.onDelete);
                                }
                            }}
                        >
                            Delete
                        </button>
                    )}
                </span>
            </div>
            {pending !== undefined && (
                <div className="notice">
                    To prove that the domain is yours, publish this DNS record, then verify. Until then nothing is served at it.
                    <dl>
                        <dt>TXT</dt>
                        <dd>
                            <code>{pending.name}</code> with the value <code>{pending.value}</code>
                        </dd>
                        {props.ingress !== undefined && (
                            <>
                                <dt>CNAME</dt>
                                <dd>
                                    <code>{domain.hostname}</code> to <code>{props.ingress}</code>, for the traffic and the certificate. Publish it before the first Route: the certificate is
                                    requested then, and a failed attempt is tried again only after an hour.
                                </dd>
                            </>
                        )}
                    </dl>
                    <button type="button" disabled={busy} onClick={() => void act(props.onVerify)}>
                        {busy ? 'Looking it up…' : 'Verify'}
                    </button>
                </div>
            )}
            {problem !== undefined && problem.about === about && <p role="alert">{problem.text}</p>}
            {routes.length === 0 ? (
                <small>No Routes: every path answers 404.</small>
            ) : (
                <table>
                    <thead>
                        <tr>
                            <th>Path</th>
                            <th>Goes to</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {routes.map((route) => (
                            <tr key={route.id}>
                                <td>
                                    <code>{route.pathPrefix}</code>
                                </td>
                                <td>{targetLabel(route, targets)}</td>
                                <td>
                                    <button
                                        type="button"
                                        className="link danger"
                                        disabled={busy}
                                        onClick={() => {
                                            if (window.confirm(`Delete the Route ${route.pathPrefix} of ${domain.hostname}? What it goes to stays.`)) {
                                                void act(() => props.onDeleteRoute(route));
                                            }
                                        }}
                                    >
                                        Delete
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {adding && (
                <RouteForm
                    routes={routes}
                    allRoutes={props.allRoutes}
                    targets={targets}
                    onCreate={async (input) => {
                        const refusal = await props.onCreateRoute(input);
                        if (refusal === undefined) {
                            setAdding(false);
                        }
                        return refusal;
                    }}
                />
            )}
        </li>
    );
}

function RouteForm(props: {
    readonly routes: readonly Route[];
    readonly allRoutes: readonly Route[];
    readonly targets: Targets;
    readonly onCreate: (input: RouteInput) => Change;
}) {
    const [fields, setFields] = useState(NEW_ROUTE);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<Problem>(undefined);
    const options = targetOptions(props.targets);
    const typed = JSON.stringify(fields);
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        const input = routeInput(fields, props.routes, props.targets, props.allRoutes);
        if (typeof input === 'string') {
            setProblem({ text: input, about: typed });
            return;
        }
        setBusy(true);
        const refusal = await props.onCreate(input);
        setProblem(refusal === undefined ? undefined : { text: refusal, about: typed });
        setBusy(false);
    };
    if (options.length === 0) {
        return <small>A Route goes to a Bucket or to a Service with a port: create one first.</small>;
    }
    return (
        <form onSubmit={(event) => void submit(event)}>
            <label>
                Path
                <input value={fields.pathPrefix} placeholder="/" onChange={(event) => setFields({ ...fields, pathPrefix: event.target.value })} />
            </label>
            <label>
                Goes to
                <select value={fields.target} onChange={(event) => setFields({ ...fields, target: event.target.value })}>
                    <option value="">Choose…</option>
                    {options.map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
            </label>
            {fields.target.startsWith('bucket:') && (
                <label>
                    <span>
                        <input type="checkbox" checked={fields.spaFallback} onChange={(event) => setFields({ ...fields, spaFallback: event.target.checked })} /> Single-page app
                    </span>
                </label>
            )}
            <button type="submit" disabled={busy}>
                {busy ? 'Working…' : 'Add Route'}
            </button>
            <small>
                Everything below the path goes there. A Bucket gets the path without the prefix, and with &quot;Single-page app&quot; a path without an object serves index.html; a Service
                gets the path as it came.
            </small>
            {problem !== undefined && problem.about === typed && <small role="alert">{problem.text}</small>}
        </form>
    );
}

export function DomainForm(props: { readonly existing: readonly Domain[]; readonly onCreate: (input: CustomDomainInput) => Change }) {
    return (
        <>
            <h3>New custom domain</h3>
            <OneFieldForm
                label="Hostname"
                placeholder="www.example.com"
                submit="Add Domain"
                note="A hostname of your own. It is served once you have proven with a DNS record that it is yours."
                onSubmit={async (typed) => {
                    const hostname = hostnameOf(typed);
                    return hostnameProblem(hostname, props.existing) ?? (await props.onCreate({ hostname }));
                }}
            />
        </>
    );
}
