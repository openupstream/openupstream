import type { Site, SiteInfo } from '@openupstream/sdk';

/** How a Site is shown: where it is, as the installation describes it, then its id (ADR-0007). */
export const siteLabel = (site: SiteInfo): string => (site.description === null ? site.id : `${site.description} · ${site.id}`);

/** A Site by its id; the id alone when the list does not have it (not read, or its nodes are gone). */
export const siteName = (id: Site, sites: readonly SiteInfo[]): string => {
    const found = sites.find((site) => site.id === id);
    return found === undefined ? id : siteLabel(found);
};

/** The default Site's id; empty when the list is empty, which the API then fills in. */
export const defaultSiteOf = (sites: readonly SiteInfo[]): Site => sites.find((site) => site.default)?.id ?? sites[0]?.id ?? '';

/**
 * The options of a Site select: every compute Site, and `current` too when
 * the list lacks it, so a Service or Job keeps showing the Site it has.
 */
export const siteChoices = (sites: readonly SiteInfo[], current: Site): readonly { readonly id: Site; readonly label: string }[] => [
    ...sites.map((site) => ({ id: site.id, label: siteLabel(site) })),
    ...(current === '' || sites.some((site) => site.id === current) ? [] : [{ id: current, label: current }]),
];
