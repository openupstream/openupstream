'use client';

import type { NodeInfo, NodesReport, SiteProblem } from '@openupstream/sdk';
import { useCallback, useEffect, useState } from 'react';
import { nodeRole, problemsByNode } from '../lib/nodes';
import { api, refused } from '../lib/session';

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

function NodeRow({ node, problems }: { readonly node: NodeInfo; readonly problems: readonly SiteProblem[] }) {
    return (
        <>
            <tr>
                <td>
                    <code>{node.name}</code>
                </td>
                <td>{node.site === null ? '–' : node.description === null ? node.site : `${node.description} · ${node.site}`}</td>
                <td>{nodeRole(node)}</td>
                <td>{node.default ? 'default' : ''}</td>
                <td>
                    <span className={`state ${node.ready ? 'ready' : 'failed'}`}>{node.ready ? 'Ready' : 'NotReady'}</span>
                </td>
                <td>{problems.length === 0 ? '' : <span className="state failed">needs attention</span>}</td>
            </tr>
            {problems.length > 0 && (
                <tr>
                    <td colSpan={6}>
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
 * The installation's nodes by Site, with what is wrong with their Site
 * labels and the command that fixes it (ADR-0008); for madAuth's admins.
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

    if (report === undefined) {
        return problem === undefined ? <p aria-busy="true">Loading…</p> : <p role="alert">{problem}</p>;
    }
    const { byNode, general } = problemsByNode(report.problems);
    return (
        <section>
            <h1>Sites &amp; nodes</h1>
            {problem !== undefined && <p role="alert">{problem}</p>}
            {report.problems.length === 0 ? (
                <p className="notice">Every node&apos;s Site labels are as they should be.</p>
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
            <table>
                <thead>
                    <tr>
                        <th>Node</th>
                        <th>Site</th>
                        <th>Role</th>
                        <th>Default</th>
                        <th>State</th>
                        <th />
                    </tr>
                </thead>
                <tbody>
                    {report.nodes.map((node) => (
                        <NodeRow key={node.name} node={node} problems={byNode.get(node.name) ?? []} />
                    ))}
                </tbody>
            </table>
            <p>
                <small>
                    A node gets its labels when it joins (docs/self-hosting.md); a <em>compute</em> node runs Databases, Services and Jobs, a{' '}
                    <em>quorum-only</em> node only etcd, Garage and Loki.
                </small>
            </p>
        </section>
    );
}
