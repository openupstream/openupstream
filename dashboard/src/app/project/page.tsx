'use client';

import { useEffect, useState } from 'react';
import { ProjectPage } from '../../components/project';
import { Shell } from '../../components/shell';

/**
 * One Project, named in the address as `/project?id=<id>`: the dashboard is
 * static files (decision 116), so there is no page per Project to build.
 */
export default function Project() {
    // Read in the browser only: the built page has no address yet.
    const [id, setId] = useState<string | null | undefined>(undefined);
    useEffect(() => setId(new URLSearchParams(window.location.search).get('id')), []);
    return (
        <Shell>
            {(user) =>
                id === undefined ? (
                    <p aria-busy="true">Loading…</p>
                ) : id === null ? (
                    <p role="alert">
                        No Project is named in this address. <a href="/">To your Projects</a>
                    </p>
                ) : (
                    <ProjectPage key={`${user.id} ${id}`} id={id} />
                )
            }
        </Shell>
    );
}
