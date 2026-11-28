'use client';

import type { NodeInfo, NodesReport, SiteDetails, SiteProblem } from '@openupstream/sdk';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { MAX_DESCRIPTION_LENGTH, descriptionProblem, nodeRole, problemsByNode } from '../lib/nodes';
import { api, refused } from '../lib/session';
import { siteLabel } from '../lib/sites';

/** How often the page reads the nodes again: the control plane reads them every 30 s. */
const REFRESH_MS = 30_000;

function Problem({ problem }: { readonly problem: SiteProblem }) {
    return (
        <li>
            {problem.message}
            <br />
            <code>{problem.fix}</code>
        </li>
    );
}

/** A Site's name, changed in place; empty removes it, so the id is shown alone. */
function SiteRow({ site, onSave }: { readonly site: SiteDetails; readonly onSave: (description: string) => Promise<boolean> }) {
    const [text, setText] = useState(site.description ?? '');
    const [saving, setSaving] = useState(false);
    // A refresh brings the saved name; keep what is typed until then.
    useEffect(() => setText(site.description ?? ''), [site.description]);
    const problem = descriptionProblem(text);
    const changed = text.trim() !== (site.description ?? '');
    const submit = async (event: FormEvent) => {
        event.preventDefault();
        setSaving(true);
        await onSave(text.trim());
        setSaving(false);
    };
    return (
        <tr>
            <td>
                <code>{site.id}</code>
            </td>
            <td>
                <form onSubmit={(event) => void submit(event)}>
                    <input
                        aria-label={`Name of Site ${site.id}`}
                        placeholder="e.g. Minisforum at home"
                        value={text}
                        maxLength={MAX_DESCRIPTION_LENGTH + 20}
                        aria-invalid={problem !== undefined}
                        onChange={(event) => setText(event.target.value)}
                    />
                    <button type="submit" disabled={!changed || problem !== undefined || saving}>
                        Save
                    </button>
                </form>
                {problem !== undefined && <small role="alert">{problem}</small>}
            </td>
            <td>{site.compute ? 'compute' : 'quorum-only'}</td>
            <td>{site.default ? 'default' : ''}</td>
        </tr>
    );
}

function NodeRow({ node, sites, problems }: { readonly node: NodeInfo; readonly sites: readonly SiteDetails[]; readonly problems: readonly SiteProblem[] }) {
    const site = sites.find((each) => each.id === node.site);
    return (
        <>
            <tr>
                <td>
                    <code>{node.name}</code>
                </td>
                <td>{node.site === null ? '–' : site === undefined ? node.site : siteLabel(site)}</td>
                <td>{nodeRole(node)}</td>
                <td>
                    <span className={`state ${node.ready ? 'ready' : 'failed'}`}>{node.ready ? 'Ready' : 'NotReady'}</span>
                </td>
                <td>{problems.length === 0 ? '' : <span className="state failed">needs attention</span>}</td>
            </tr>
            {problems.length > 0 && (
                <tr>
                    <td colSpan={5}>
                        <ul>
                            {problems.map((problem) => (
                                <Problem key={problem.kind} problem={problem} />
                            ))}
                        </ul>
                    </td>
                </tr>
            )}
        </>
    );
}

/**
 * The installation's Sites, which admins name here (ADR-0009), and its
 * nodes, with what is wrong with their Site labels and the command that
 * fixes it (ADR-0008); for madAuth's admins.
 */
export function NodesPage() {
    const [report, setReport] = useState<NodesReport | undefined>(undefined);
    const [problem, setProblem] = useState<string | undefined>(undefined);
    const refresh = useCallback(async () => {
        const result = await (await api()).listNodes();
        setProblem(result.ok ? undefined : refused(result.error));
        if (result.ok) {
            setReport(result.value);
        }
    }, []);
    useEffect(() => {
        void refresh();
        // Only while the page is in front, like a Project's page.
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible') {
                void refresh();
            }
        }, REFRESH_MS);
        return () => window.clearInterval(timer);
    }, [refresh]);

    const rename = async (site: string, description: string): Promise<boolean> => {
        const result = await (await api()).setSiteDescription(site, { description: description === '' ? null : description });
        if (!result.ok) {
            setProblem(refused(result.error));
            return false;
        }
        await refresh();
        return true;
    };

    if (report === undefined) {
        return problem === undefined ? <p aria-busy="true">Loading…</p> : <p role="alert">{problem}</p>;
    }
    const { byNode, general } = problemsByNode(report.problems);
    return (
        <section>
            <h1>Sites &amp; nodes</h1>
            {problem !== undefined && <p role="alert">{problem}</p>}
            {report.problems.length === 0 ? (
                <p className="notice success">Every node&apos;s Site labels are as they should be.</p>
            ) : (
                <p role="alert">
                    {report.problems.length === 1 ? 'One problem needs' : `${report.problems.length} problems need`} attention. Each comes with the command that
                    fixes it; the alerts of the same names fire after 10 minutes.
                </p>
            )}
            {general.length > 0 && (
                <ul>
                    {general.map((each) => (
                        <Problem key={`${each.kind} ${each.site ?? ''}`} problem={each} />
                    ))}
                </ul>
            )}
            <h2>Sites</h2>
            <p>
                <small>
                    A Site is a place that can fail as a whole, not a machine; for example, one data centre of one provider. A Site&apos;s id can only be set
                    during creation. Its name is what everyone sees next to the id; change it here anytime.
                </small>
            </p>
            <table>
                <thead>
                    <tr>
                        <th>Site</th>
                        <th>Name</th>
                        <th>Role</th>
                        <th>Default</th>
                    </tr>
                </thead>
                <tbody>
                    {report.sites.map((site) => (
                        <SiteRow key={site.id} site={site} onSave={(description) => rename(site.id, description)} />
                    ))}
                </tbody>
            </table>
            <h2>Nodes</h2>
            <table>
                <thead>
                    <tr>
                        <th>Node</th>
                        <th>Site</th>
                        <th>Role</th>
                        <th>State</th>
                        <th />
                    </tr>
                </thead>
                <tbody>
                    {report.nodes.map((node) => (
                        <NodeRow key={node.name} node={node} sites={report.sites} problems={byNode.get(node.name) ?? []} />
                    ))}
                </tbody>
            </table>
            <p>
                <small>
                    A node is named after its machine: the VM&apos;s name, or the computer&apos;s hostname. Its Site and role come from the labels its machine
                    gets when it joins the cluster (docs/self-hosting.md); a <em>compute</em> node runs Databases, Services and Jobs, a <em>quorum-only</em>{' '}
                    node only etcd, Garage and Loki.
                </small>
            </p>
        </section>
    );
}
