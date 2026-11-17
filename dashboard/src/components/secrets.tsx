'use client';

import type { Secret } from '@openupstream/sdk';
import { useState } from 'react';

/**
 * The Project's Secrets by name. A value is set with `oup secret set`: the
 * page has no field for one (decision 129), and the API never returns one.
 */
export function Secrets(props: { readonly secrets: readonly Secret[]; readonly onDelete: (name: string) => Promise<string | undefined> }) {
    const { secrets } = props;
    const [busy, setBusy] = useState(false);
    // A refusal is about the Secrets there were then: gone once they differ.
    const [problem, setProblem] = useState<{ readonly text: string; readonly about: string } | undefined>(undefined);
    const about = secrets.map((secret) => `${secret.name} ${secret.updatedAt}`).join(' ');
    return (
        <>
            {secrets.length === 0 ? (
                <p>No Secrets yet. A Secret is an environment variable of every Service and Job of the Project, such as an API key.</p>
            ) : (
                <table>
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Value set</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {secrets.map((secret) => (
                            <tr key={secret.id}>
                                <td>
                                    <code>{secret.name}</code>
                                </td>
                                <td>{new Date(secret.updatedAt).toLocaleString()}</td>
                                <td>
                                    <button
                                        type="button"
                                        className="link danger"
                                        disabled={busy}
                                        onClick={() => {
                                            if (window.confirm(`Delete the Secret ${secret.name}? The Project's Services restart without it.`)) {
                                                setBusy(true);
                                                void props.onDelete(secret.name).then((refusal) => {
                                                    setProblem(refusal === undefined ? undefined : { text: refusal, about });
                                                    setBusy(false);
                                                });
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
            {problem !== undefined && problem.about === about && <p role="alert">{problem.text}</p>}
            <p>
                <small>
                    A value is set, and replaced, with <a href="/cli">oup secret set NAME</a>, which reads it from its input; it is never typed into this page and never shown anywhere.
                </small>
            </p>
        </>
    );
}
