'use client';

import { COMPUTE_SITES, type ResourceUsage, type ServiceDetails, type ServiceInput, type ServicePatch } from '@openupstream/sdk';
import { type FormEvent, type ReactNode, useState } from 'react';
import { NEW_SERVICE, type ServiceFields, type ServiceWanted, fieldsOf, serviceInput, serviceNameProblem, servicePatch, serviceWanted, shortDigest } from '../lib/services';
import { Logs } from './logs';
import { Usage } from './usage';

/** A Service: what runs, its state and usage, and the ways to change it. */
export function ServiceCard(props: {
    readonly service: ServiceDetails;
    readonly usage: ResourceUsage | undefined;
    readonly onChange: (patch: ServicePatch) => Promise<string | undefined>;
    readonly onRedeploy: () => Promise<string | undefined>;
    readonly onDelete: () => Promise<string | undefined>;
}) {
    const { service, usage } = props;
    const [changing, setChanging] = useState(false);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const act = async (run: () => Promise<string | undefined>) => {
        setBusy(true);
        setProblem(await run());
        setBusy(false);
    };
    return (
        <li>
            <div className="resource-head">
                <span>
                    <strong>{service.name}</strong> <span className={`state ${service.state}`}>{service.state}</span>
                </span>
                <span className="actions">
                    <button type="button" className="link" onClick={() => setChanging(!changing)}>
                        {changing ? 'Cancel' : 'Change'}
                    </button>
                    <button type="button" className="link" disabled={busy} title="Runs what the image's tag points at now" onClick={() => void act(props.onRedeploy)}>
                        Redeploy
                    </button>
                    <button
                        type="button"
                        className="link danger"
                        disabled={busy}
                        onClick={() => {
                            if (window.confirm(`Delete the Service ${service.name}? Its replicas stop.`)) {
                                void act(props.onDelete);
                            }
                        }}
                    >
                        Delete
                    </button>
                </span>
            </div>
            <small>
                <code>{service.image}</code> at <code>{shortDigest(service.imageDigest)}</code>, deployed {new Date(service.deployedAt).toLocaleString()}
                <br />
                {service.replicas} {service.replicas === 1 ? 'replica' : 'replicas'}, {service.memoryMb} MB memory and {service.cpuMillicores} millicores each,{' '}
                {service.port === null ? 'a worker without a port' : `port ${service.port}`}
                {service.homeSite !== null && `, in ${service.homeSite}`}
                {service.registryAuth && ', pulled with registry credentials'}
            </small>
            {problem !== undefined && <p role="alert">{problem}</p>}
            {changing && (
                <FieldsForm
                    initial={fieldsOf(service)}
                    submit="Save"
                    note="A change starts new replicas and stops the old ones once the new are ready. A new image resolves its tag again."
                    onSubmit={async (wanted) => {
                        const patch = servicePatch(service, wanted);
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
            <Logs waits source={(client, query, signal) => client.serviceLogs(service.projectId, service.id, query, signal)} />
        </li>
    );
}

export function ServiceForm(props: { readonly existing: readonly ServiceDetails[]; readonly onCreate: (input: ServiceInput) => Promise<string | undefined> }) {
    const [name, setName] = useState('');
    // A new form after each Service, so its fields start over.
    const [created, setCreated] = useState(0);
    return (
        <>
            <h3>New Service</h3>
            <FieldsForm
                key={created}
                initial={NEW_SERVICE}
                submit="Deploy Service"
                resetOn={name}
                note={
                    <>
                        The image must be public; one from a private registry is deployed with <a href="/cli">oup service deploy</a>, which takes the registry&apos;s password.
                    </>
                }
                onSubmit={async (wanted) => {
                    const trimmed = name.trim();
                    const found = serviceNameProblem(trimmed, props.existing);
                    if (found !== undefined) {
                        return found;
                    }
                    const refusal = await props.onCreate(serviceInput(trimmed, wanted));
                    if (refusal === undefined) {
                        setName('');
                        setCreated(created + 1);
                    }
                    return refusal;
                }}
            >
                <label>
                    Name
                    <input value={name} placeholder="api" maxLength={63} onChange={(event) => setName(event.target.value)} />
                </label>
            </FieldsForm>
        </>
    );
}

/** A Service's fields with a button; `children` are further fields in front. Shows what `onSubmit` returns. */
function FieldsForm(props: {
    readonly initial: ServiceFields;
    readonly submit: string;
    readonly note: ReactNode;
    /** The further fields' values: a change of them takes the message away, as a change of these fields does. */
    readonly resetOn?: string;
    readonly children?: ReactNode;
    readonly onSubmit: (wanted: ServiceWanted) => Promise<string | undefined>;
}) {
    const [fields, setFields] = useState(props.initial);
    const [busy, setBusy] = useState(false);
    // What was wrong is about what was typed then: kept with it, and gone once anything differs.
    const [problem, setProblem] = useState<{ readonly text: string; readonly about: string } | undefined>(undefined);
    const typed = JSON.stringify([fields, props.resetOn]);
    const set = (field: keyof ServiceFields) => (event: { readonly target: { readonly value: string } }) => setFields({ ...fields, [field]: event.target.value });
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        const wanted = serviceWanted(fields);
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
                <input value={fields.image} placeholder="ghcr.io/acme/api:v3" onChange={set('image')} />
            </label>
            <label>
                Port (empty: a worker)
                <input value={fields.port} inputMode="numeric" onChange={set('port')} />
            </label>
            <label>
                Replicas
                <input value={fields.replicas} inputMode="numeric" onChange={set('replicas')} />
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
                Site of a single replica
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
