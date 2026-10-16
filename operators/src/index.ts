/**
 * openupstream operators.
 *
 * Small reconcilers for the things no off-the-shelf operator does:
 *
 * - routing table → Traefik IngressRoute + cert-manager Certificate
 * - static site   → Garage bucket website config + ingress rule
 * - tenant        → CloudNativePG Cluster (+ replica cluster in the other
 *                   region), PgBouncer Pooler, backup schedule
 *
 * Everything else (Postgres failover, TLS issuance, scheduling) is left to
 * CloudNativePG, cert-manager and Kubernetes itself.
 */
export const OPERATORS = ['routing', 'sites', 'tenants'] as const;
export type Operator = (typeof OPERATORS)[number];
