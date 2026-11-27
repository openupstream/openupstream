/**
 * The compute Sites, read from the nodes' labels (ADR-0007): a node's Site
 * is its zone label; the compute label makes it a compute Site, the default
 * label the default Home site, and the description annotation says where it
 * is. Nothing here names a Site.
 */
import type { Site, SiteInfo } from '@openupstream/sdk';
import { type Result, err, ok } from './result.js';

/** What the control plane reads from a node. */
export interface NodeLabels {
    readonly name: string;
    /** Its zone label: the Site; undefined when it has none. */
    readonly site: string | undefined;
    readonly compute: boolean;
    readonly default: boolean;
    readonly description: string | undefined;
    readonly createdAt: string;
}

export interface Sites {
    /** The compute Sites by id, the default one marked. */
    readonly list: readonly SiteInfo[];
    /** The default Home site; undefined only when there is no compute Site at all. */
    readonly default: Site | undefined;
    /** The Site of each compute node. */
    readonly nodes: ReadonlyMap<string, Site>;
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The compute Sites the nodes describe. The default is the labelled Site;
 * when none or several are labelled (the install allows exactly one), the
 * first by id among them, or among all, so there always is one. A Site's
 * description is its oldest node's.
 */
export function sitesOf(nodes: readonly NodeLabels[]): Sites {
    const compute = nodes.filter((node): node is NodeLabels & { site: string } => node.compute && node.site !== undefined && node.site !== '');
    const ids = [...new Set(compute.map((node) => node.site))].sort(byId);
    const labelled = ids.filter((id) => compute.some((node) => node.site === id && node.default));
    const defaultSite = (labelled.length > 0 ? labelled : ids)[0];
    const oldestFirst = [...compute].sort((a, b) => byId(a.createdAt, b.createdAt) || byId(a.name, b.name));
    const description = (id: string) => oldestFirst.find((node) => node.site === id && node.description !== undefined && node.description.trim() !== '')?.description?.trim() ?? null;
    return {
        list: ids.map((id) => ({ id, description: description(id), default: id === defaultSite })),
        default: defaultSite,
        nodes: new Map(compute.map((node) => [node.name, node.site])),
    };
}

/** How long the node list is used before it is read again. */
export const SITES_TTL_MS = 30_000;

export type ReadSites = () => Promise<Result<Sites, string>>;

/**
 * Reads the Sites at most every `ttlMs`. When reading fails, the last list
 * read stays in use however old it is; without one, the error is returned.
 */
export function siteReader(listNodes: () => Promise<Result<readonly NodeLabels[], string>>, ttlMs = SITES_TTL_MS, now: () => number = Date.now): ReadSites {
    let cached: { readonly at: number; readonly sites: Sites } | undefined;
    let pending: Promise<Result<Sites, string>> | undefined;
    const refresh = async (): Promise<Result<Sites, string>> => {
        const nodes = await listNodes();
        if (!nodes.ok) {
            return cached === undefined ? err(nodes.error) : ok(cached.sites);
        }
        cached = { at: now(), sites: sitesOf(nodes.value) };
        return ok(cached.sites);
    };
    return () => {
        if (cached !== undefined && now() - cached.at < ttlMs) {
            return Promise.resolve(ok(cached.sites));
        }
        pending ??= refresh().finally(() => {
            pending = undefined;
        });
        return pending;
    };
}

/** Why a Site cannot be the Home site of something new or changed. */
export type SiteRefusal = { readonly kind: 'unknown'; readonly site: string; readonly sites: readonly Site[] } | { readonly kind: 'none' };

/** The Site to use: `wanted` when it is a compute Site, the default when it is not given. */
export function chooseSite(sites: Sites, wanted: string | undefined): Result<Site, SiteRefusal> {
    if (wanted === undefined) {
        return sites.default === undefined ? err({ kind: 'none' }) : ok(sites.default);
    }
    return sites.list.some((site) => site.id === wanted) ? ok(wanted) : err({ kind: 'unknown', site: wanted, sites: sites.list.map((site) => site.id) });
}
