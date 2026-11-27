/** `oup sites`: the compute Sites, as the installation's nodes say (ADR-0007). */
import type { SiteInfo } from '@openupstream/sdk';

/** One line per Site: its id, `default` for the default Site, and where it is. */
export const formatSites = (sites: readonly SiteInfo[]): string[] => {
    const width = Math.max(4, ...sites.map((site) => site.id.length));
    return sites.map((site) => `${site.id.padEnd(width)}  ${(site.default ? 'default' : '').padEnd(7)}  ${site.description ?? ''}`.trimEnd());
};
