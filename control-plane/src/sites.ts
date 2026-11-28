/**
 * The compute Sites, read from the nodes' labels (ADR-0007): a node's Site
 * is its zone label; the compute label makes it a compute Site, the default
 * label the default Home site, and the description annotation says where it
 * is. Nothing here names a Site.
 */
import {
    COMPUTE_SITE_LABEL,
    DEFAULT_SITE_LABEL,
    QUORUM_ONLY_TAINT,
    type NodeInfo,
    type NodesReport,
    type Site,
    type SiteInfo,
    type SiteProblem,
    ZONE_LABEL,
} from '@openupstream/sdk';
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
    /** It carries the quorum-only taint with the effect NoSchedule. */
    readonly quorumOnly: boolean;
    /** Its Ready condition is True. */
    readonly ready: boolean;
}

export interface Sites {
    /** The compute Sites by id, the default one marked. */
    readonly list: readonly SiteInfo[];
    /** The default Home site; undefined only when there is no compute Site at all. */
    readonly default: Site | undefined;
    /** The Site of each compute node. */
    readonly nodes: ReadonlyMap<string, Site>;
    /** Every node as it was read, compute or not. */
    readonly all: readonly NodeLabels[];
    /** When the nodes were read, in ms since the epoch; a failed read keeps the last time. */
    readonly readAt: number;
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The compute Sites the nodes describe. The default is the labelled Site;
 * when none or several are labelled (the install allows exactly one), the
 * first by id among them, or among all, so there always is one. A Site's
 * description is its oldest node's.
 */
export function sitesOf(nodes: readonly NodeLabels[], readAt = 0): Sites {
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
        all: nodes,
        readAt,
    };
}

/** How long the node list is used before it is read again. */
export const SITES_TTL_MS = 30_000;

export type ReadSites = () => Promise<Result<Sites, string>>;

/**
 * Reads the Sites at most every `ttlMs`. When reading fails, the failure is
 * logged and the last list read stays in use for another `ttlMs`, however
 * old it is, so an unreachable API server is not asked on every request;
 * without one, the error is returned.
 */
export function siteReader(
    listNodes: () => Promise<Result<readonly NodeLabels[], string>>,
    ttlMs = SITES_TTL_MS,
    now: () => number = Date.now,
    log?: (entry: Record<string, unknown>) => void,
): ReadSites {
    let cached: { readonly at: number; readonly sites: Sites } | undefined;
    let pending: Promise<Result<Sites, string>> | undefined;
    const refresh = async (): Promise<Result<Sites, string>> => {
        const nodes = await listNodes();
        if (!nodes.ok) {
            log?.({ msg: 'cannot list the nodes; the last Sites read stay in use', error: nodes.error, stale: cached !== undefined });
            if (cached === undefined) {
                return err(nodes.error);
            }
            cached = { at: now(), sites: cached.sites };
            return ok(cached.sites);
        }
        const at = now();
        cached = { at, sites: sitesOf(nodes.value, at) };
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

const QUORUM_TAINT = `${QUORUM_ONLY_TAINT}=true:NoSchedule`;

/**
 * What is wrong with the nodes' Site labels: the rules of the install's
 * `check_sites` (infra/dev-cluster/lib.sh), checked again while the cluster
 * runs (ADR-0008), each with the command that fixes it. Every node has a
 * Site; a node is either labelled compute or tainted quorum-only, never
 * both; the nodes of a Site agree on the compute and the default label;
 * exactly one Site is the default, a compute one. With more than one node
 * in a Site (a single-node install has exactly one), at least two compute
 * Sites, for a Database's standby, and three Sites, for etcd's and
 * Garage's quorum.
 */
export function siteProblems(nodes: readonly NodeLabels[]): SiteProblem[] {
    const siteOf = (node: NodeLabels) => (node.site === undefined || node.site === '' ? undefined : node.site);
    const problem = (kind: SiteProblem['kind'], node: string | null, site: string | null, message: string, fix: string): SiteProblem => ({
        kind,
        node,
        site,
        message,
        fix,
    });
    const byNode = [...nodes]
        .sort((a, b) => byId(a.name, b.name))
        .flatMap((node): SiteProblem[] => {
            const site = siteOf(node) ?? null;
            return [
                ...(site === null
                    ? [problem('node-without-site', node.name, null, `Node ${node.name} has no Site.`, `kubectl label node ${node.name} ${ZONE_LABEL}=<Site id>`)]
                    : []),
                ...(!node.compute && !node.quorumOnly
                    ? [
                          problem(
                              'node-neither-compute-nor-quorum',
                              node.name,
                              site,
                              `Node ${node.name} is neither labelled compute nor tainted quorum-only, so Databases, Services and Jobs never run there while other pods may.`,
                              `kubectl label node ${node.name} ${COMPUTE_SITE_LABEL}=true, or kubectl taint node ${node.name} ${QUORUM_TAINT}`,
                          ),
                      ]
                    : []),
                ...(node.compute && node.quorumOnly
                    ? [
                          problem(
                              'node-compute-and-quorum',
                              node.name,
                              site,
                              `Node ${node.name} is labelled compute but tainted quorum-only, so nothing of a compute Site runs there.`,
                              `kubectl taint node ${node.name} ${QUORUM_ONLY_TAINT}-, or kubectl label node ${node.name} ${COMPUTE_SITE_LABEL}-`,
                          ),
                      ]
                    : []),
            ];
        });

    const zoned = nodes.flatMap((node) => {
        const site = siteOf(node);
        return site === undefined ? [] : [{ ...node, site }];
    });
    const ids = [...new Set(zoned.map((node) => node.site))].sort(byId);
    const ofSite = (id: string) => zoned.filter((node) => node.site === id);
    const compute = ids.filter((id) => ofSite(id).some((node) => node.compute));
    const defaults = ids.filter((id) => ofSite(id).some((node) => node.default));
    const bySite = ids.flatMap((id): SiteProblem[] => {
        const members = ofSite(id);
        const mixed = (has: (node: NodeLabels) => boolean) => members.some(has) && !members.every(has);
        return [
            ...(mixed((node) => node.compute)
                ? [
                      problem(
                          'site-mixed-compute',
                          null,
                          id,
                          `Only some nodes of Site ${id} are labelled compute.`,
                          `kubectl label nodes -l ${ZONE_LABEL}=${id} ${COMPUTE_SITE_LABEL}=true, or ${COMPUTE_SITE_LABEL}- on all of them`,
                      ),
                  ]
                : []),
            ...(mixed((node) => node.default)
                ? [
                      problem(
                          'site-mixed-default',
                          null,
                          id,
                          `Only some nodes of Site ${id} are labelled the default Site.`,
                          `kubectl label nodes -l ${ZONE_LABEL}=${id} ${DEFAULT_SITE_LABEL}=true, or ${DEFAULT_SITE_LABEL}- on all of them`,
                      ),
                  ]
                : []),
            ...(defaults.includes(id) && !compute.includes(id)
                ? [
                      problem(
                          'default-site-not-compute',
                          null,
                          id,
                          `The default Site ${id} is no compute Site.`,
                          `kubectl label nodes -l ${ZONE_LABEL}=${id} ${DEFAULT_SITE_LABEL}-, then kubectl label nodes -l ${ZONE_LABEL}=<compute Site> ${DEFAULT_SITE_LABEL}=true`,
                      ),
                  ]
                : []),
        ];
    });

    const cluster: SiteProblem[] = [
        ...(defaults.length === 0
            ? [
                  problem(
                      'default-site-missing',
                      null,
                      null,
                      'No Site is labelled the default; what is created without a Home site goes to the first compute Site by id.',
                      `kubectl label nodes -l ${ZONE_LABEL}=${compute[0] ?? '<compute Site>'} ${DEFAULT_SITE_LABEL}=true`,
                  ),
              ]
            : []),
        ...(defaults.length > 1
            ? [
                  problem(
                      'default-site-not-unique',
                      null,
                      null,
                      `${defaults.length} Sites are labelled the default (${defaults.join(', ')}); the first by id is used.`,
                      `kubectl label nodes -l ${ZONE_LABEL}=${defaults[defaults.length - 1]} ${DEFAULT_SITE_LABEL}- (keep one)`,
                  ),
              ]
            : []),
        ...(zoned.length > 1 && compute.length < 2
            ? [
                  problem(
                      'compute-sites-below-two',
                      null,
                      null,
                      `There ${compute.length === 1 ? 'is one compute Site' : 'are no compute Sites'}; a Database's standby needs a second one.`,
                      `kubectl label nodes -l ${ZONE_LABEL}=<Site> ${COMPUTE_SITE_LABEL}=true, and kubectl taint node <name> ${QUORUM_ONLY_TAINT}- on each of its nodes that has the taint`,
                  ),
              ]
            : []),
        ...(zoned.length > 1 && ids.length < 3
            ? [
                  problem(
                      'sites-below-three',
                      null,
                      null,
                      `The nodes are in ${ids.length} Site${ids.length === 1 ? '' : 's'}; etcd's and Garage's quorum needs three.`,
                      'join a node of another Site',
                  ),
              ]
            : []),
    ];
    return [...byNode, ...bySite, ...cluster];
}

/** Every node, by Site (those without one first) and name, and what is wrong with the Site labels. */
export function nodesReport(nodes: readonly NodeLabels[]): NodesReport {
    const info = (node: NodeLabels): NodeInfo => ({
        name: node.name,
        site: node.site === undefined || node.site === '' ? null : node.site,
        compute: node.compute,
        default: node.default,
        quorumOnly: node.quorumOnly,
        description: node.description === undefined || node.description.trim() === '' ? null : node.description.trim(),
        ready: node.ready,
        createdAt: node.createdAt,
    });
    return {
        nodes: nodes.map(info).sort((a, b) => byId(a.site ?? '', b.site ?? '') || byId(a.name, b.name)),
        problems: siteProblems(nodes),
    };
}

const labelValue = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');

/**
 * The Site checks for Prometheus (text format 0.0.4), which the alerts of
 * infra/monitoring/rules.yaml read (ADR-0008): one series per problem while
 * it lasts, how many nodes were read and when. Without a node list nothing
 * but the help; with an old one, `SiteChecksStale` fires on its time.
 */
export function siteMetrics(sites: Pick<Sites, 'all' | 'readAt'> | undefined): string {
    const nodes = sites?.all;
    const problems = nodes === undefined ? [] : siteProblems(nodes);
    return [
        '# HELP openupstream_site_problem A problem with the nodes\' Site labels (ADR-0008), 1 while it lasts.',
        '# TYPE openupstream_site_problem gauge',
        ...problems.map(
            (problem) =>
                `openupstream_site_problem{problem="${problem.kind}",node="${labelValue(problem.node ?? '')}",site="${labelValue(problem.site ?? '')}"} 1`,
        ),
        '# HELP openupstream_site_nodes The nodes the control plane read for the Site checks.',
        '# TYPE openupstream_site_nodes gauge',
        ...(nodes === undefined ? [] : [`openupstream_site_nodes ${nodes.length}`]),
        '# HELP openupstream_site_nodes_read_timestamp_seconds When the control plane last read the nodes.',
        '# TYPE openupstream_site_nodes_read_timestamp_seconds gauge',
        ...(sites === undefined ? [] : [`openupstream_site_nodes_read_timestamp_seconds ${sites.readAt / 1000}`]),
        '',
    ].join('\n');
}
