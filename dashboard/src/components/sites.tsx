'use client';

import type { Site, SiteInfo } from '@openupstream/sdk';
import { createContext, useContext } from 'react';
import { siteChoices, siteName } from '../lib/sites';

/** The compute Sites (`GET /v1/sites`), read with the Project; empty when the API could not say. */
export const SitesContext = createContext<readonly SiteInfo[]>([]);

export const useSites = (): readonly SiteInfo[] => useContext(SitesContext);

/** A Site as the installation describes it, e.g. "Falkenstein (Hetzner) · hetzner-fsn1". */
export function SiteName({ id }: { readonly id: Site }) {
    return <>{siteName(id, useSites())}</>;
}

/** The options of a Site select, keeping `current` even when the list lacks it. */
export function SiteOptions({ current }: { readonly current: Site }) {
    return (
        <>
            {siteChoices(useSites(), current).map((choice) => (
                <option key={choice.id} value={choice.id}>
                    {choice.label}
                </option>
            ))}
        </>
    );
}
