'use client';

import { DEFAULT_API_URL } from '@openupstream/sdk';
import { useEffect, useState } from 'react';
import { type Block, type Inline, apiOf, withApi } from '../lib/docs';
import { OpenShell } from './shell';

const Text = ({ parts }: { readonly parts: readonly Inline[] }) => parts.map((part, index) => (part.code ? <code key={index}>{part.text}</code> : part.text));

/**
 * How to use `oup`, in the words of the CLI's README (`blocks`, read when
 * the dashboard is built). An installation other than the one `oup` signs
 * in to by default is named by its own address, which only the browser
 * knows: the built page has none yet.
 */
export function CliPage({ blocks, node }: { readonly blocks: readonly Block[]; readonly node: string }) {
    const [api, setApi] = useState(DEFAULT_API_URL);
    useEffect(() => setApi(apiOf(window.location.origin)), []);
    return (
        <OpenShell>
            <article className="docs">
                <h1>
                    <code>oup</code>, the command line tool
                </h1>
                <p>
                    Everything the dashboard does, and what it does not do yet, from a terminal or a CI job. It needs{' '}
                    <a href="https://nodejs.org/" rel="noreferrer">
                        Node.js
                    </a>{' '}
                    {node}.
                </p>
                {api !== DEFAULT_API_URL && (
                    <p className="notice">
                        This installation&apos;s API is <code>{api}</code>. Sign in to it with <code>oup login --api {api}</code>, which remembers the address; in CI, set{' '}
                        <code>OUP_API_URL={api}</code>.
                    </p>
                )}
                {withApi(blocks, api, DEFAULT_API_URL).map((block, index) =>
                    block.kind === 'code' ? (
                        <pre key={index}>
                            <code>{block.text}</code>
                        </pre>
                    ) : block.kind === 'list' ? (
                        <ul key={index}>
                            {block.items.map((item, at) => (
                                <li key={at}>
                                    <Text parts={item} />
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p key={index}>
                            <Text parts={block.text} />
                        </p>
                    ),
                )}
            </article>
        </OpenShell>
    );
}
