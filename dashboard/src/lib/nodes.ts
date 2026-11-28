import type { NodeInfo, SiteProblem } from '@openupstream/sdk';

/** madAuth's role for its admins, who see the installation's nodes (ADR-0008). */
export const ADMIN_ROLE = 'admin';

/** Whether madAuth's claims give the user the role `admin`; the API checks it again. */
export const isAdmin = (claims: Record<string, unknown> | undefined): boolean => {
    const roles = claims?.['roles'];
    return Array.isArray(roles) && roles.includes(ADMIN_ROLE);
};

/** What a node is for, as its compute label and its quorum-only taint say. */
export const nodeRole = (node: NodeInfo): string =>
    node.compute && node.quorumOnly ? 'compute and quorum-only' : node.compute ? 'compute' : node.quorumOnly ? 'quorum-only' : 'none';

/**
 * The problems split by what they are about: each node's own, then those
 * about a Site or the whole cluster, which no single node row can show.
 */
export const problemsByNode = (
    problems: readonly SiteProblem[],
): { readonly byNode: ReadonlyMap<string, readonly SiteProblem[]>; readonly general: readonly SiteProblem[] } => ({
    byNode: problems.reduce((map, problem) => {
        return problem.node === null ? map : new Map(map).set(problem.node, [...(map.get(problem.node) ?? []), problem]);
    }, new Map<string, readonly SiteProblem[]>()),
    general: problems.filter((problem) => problem.node === null),
});

/** The longest Site description the API takes. */
export const MAX_DESCRIPTION_LENGTH = 100;

/** What is wrong with a Site description as typed, or undefined; empty removes it. */
export const descriptionProblem = (text: string): string | undefined =>
    text.trim().length > MAX_DESCRIPTION_LENGTH ? `At most ${MAX_DESCRIPTION_LENGTH} characters.` : undefined;
