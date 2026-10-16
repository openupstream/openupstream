/**
 * openupstream operators.
 *
 * Small reconcilers for the things no off-the-shelf operator does:
 *
 * - routing table → Traefik IngressRoute + cert-manager Certificate
 * - static site   → Garage bucket website config + ingress rule
 * - database      → CloudNativePG Cluster (one instance per compute site),
 *                   PgBouncer Pooler, backup schedule
 * - secrets       → Kubernetes Secret in the project's namespace
 *
 * Everything else (Postgres failover, TLS issuance, scheduling) is left to
 * CloudNativePG, cert-manager and Kubernetes itself.
 */
export const OPERATORS = ['routing', 'sites', 'databases', 'secrets'] as const;
export type Operator = (typeof OPERATORS)[number];
