/**
 * The reconcile step for Databases (ARCHITECTURE.md, "Operators"): brings the
 * cluster in line with the control plane's rows.
 *
 * It only creates and updates. A Database whose row is gone is not deleted
 * here: deleting a Cluster deletes its volumes, so that is an explicit step
 * of the control plane's delete, never the result of a row missing from a
 * listing.
 *
 * `planDatabases` is pure and decides everything; `reconcileDatabases` reads
 * the backup credentials and the Clusters that exist, applies the plan with
 * server-side apply and reports.
 */
import { type DatabaseRow, type Project, clusterName } from '@openupstream/sdk';
import { type Kube, type KubeError, type KubeObject, type ObjectRef, refOf } from '../kube.js';
import { LABELS, MANAGED_BY, databaseMetricsPolicyFor, projectNamespace, projectObjectsFor } from '../kubernetes.js';
import { type Result, err, ok } from '../result.js';
import {
    BACKUP_CREDENTIAL_KEYS,
    type DatabaseConfig,
    type DatabaseManifests,
    type LiveCluster,
    type RestoreError,
    databaseManifests,
    liveClusterOf,
    restoredDatabaseManifests,
} from './manifests.js';
import { type TunnelSettings, tunnelObjects } from './tunnel.js';

export type { DatabaseRow };

/** Objects that must be applied one after the other, in this order. */
export type ApplyChain = readonly KubeObject[];

export interface DatabasePlan {
    /**
     * Per Project: its namespace and NetworkPolicy, the policy that lets
     * Prometheus scrape its Databases, then its backup credentials, and its
     * database tunnel once a caller has a role there. Applied first.
     */
    readonly projects: readonly ApplyChain[];
    /** Per Database: ObjectStore, Cluster, Pooler, ScheduledBackup. */
    readonly databases: readonly ApplyChain[];
    /** Rows that cannot run; their existing objects are left alone. */
    readonly invalid: readonly { readonly databaseId: string; readonly errors: readonly RestoreError[] }[];
}

/** The platform's backup credentials, copied into a Project's namespace. */
const backupSecretFor = (project: Project, config: DatabaseConfig, data: Readonly<Record<string, string>>): KubeObject => ({
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
        name: config.backup.credentialsSecret,
        namespace: projectNamespace(project.id),
        labels: { [LABELS.projectId]: project.id, [LABELS.managedBy]: MANAGED_BY },
    },
    data,
});

const uniqueBy = <T>(items: readonly T[], key: (item: T) => string): T[] => [
    ...new Map(items.map((item) => [key(item), item])).values(),
];

/**
 * A restoring Database gets the recovery bootstrap, which names the
 * source's ObjectStore. Once the control plane has recorded the restore as
 * finished, its Cluster is rendered like any other: the Barman Cloud plugin
 * stops every reconcile of a Cluster that names a missing ObjectStore
 * (failovers included, seen on the dev cluster 2026-11-10), and the source's
 * goes after its retention window. CloudNativePG reads the bootstrap only
 * when it creates the Cluster, so dropping it changes nothing else.
 */
const manifestsFor = (row: DatabaseRow, config: DatabaseConfig, live: LiveCluster | undefined): Result<DatabaseManifests, RestoreError[]> => {
    const restore = row.database.restoredFrom;
    const roles = row.roles ?? [];
    return restore === undefined || row.restoring !== true
        ? databaseManifests(row.project, row.database, config, roles, live)
        : restoredDatabaseManifests(
              row.project,
              row.database,
              config,
              { database: { id: restore.databaseId, projectId: row.project.id }, targetTime: restore.targetTime },
              roles,
              live,
          );
};

/** The Clusters that exist, by `liveClusterKey`. */
export type LiveClusters = ReadonlyMap<string, LiveCluster>;

export const liveClusterKey = (namespace: string, name: string): string => `${namespace}/${name}`;

/**
 * What to apply so the cluster runs every Database in `rows`.
 * `backupCredentials` is the `data` of the platform's backup credentials
 * Secret. Without `tunnel` no Project gets a database tunnel; the roles
 * are added to the Clusters all the same. `live` holds the Clusters that
 * exist: one keeps its `shared_buffers` through a grow (decision 152).
 */
export function planDatabases(
    rows: readonly DatabaseRow[],
    config: DatabaseConfig,
    backupCredentials: Readonly<Record<string, string>>,
    tunnel?: TunnelSettings,
    live: LiveClusters = new Map(),
): DatabasePlan {
    const liveOf = (row: DatabaseRow) => live.get(liveClusterKey(projectNamespace(row.project.id), clusterName(row.database)));
    const results = rows.map((row) => ({ row, result: manifestsFor(row, config, liveOf(row)) }));
    const valid = results.flatMap(({ row, result }) => (result.ok ? [{ row, manifests: result.value }] : []));
    const projects = uniqueBy(
        valid.map(({ row }) => row.project),
        (project) => project.id,
    );
    const tunnelHosts = new Map(rows.flatMap((row) => (row.tunnelHostname === undefined ? [] : [[row.project.id, row.tunnelHostname] as const])));
    return {
        projects: projects.map((project) => {
            const hostname = tunnelHosts.get(project.id);
            return [
                ...projectObjectsFor(project),
                databaseMetricsPolicyFor(project.id),
                backupSecretFor(project, config, backupCredentials),
                ...(tunnel === undefined || hostname === undefined ? [] : tunnelObjects(project.id, hostname, tunnel)),
            ];
        }),
        databases: valid.map(({ manifests }) => [
            manifests.objectStore,
            manifests.cluster,
            manifests.pooler,
            manifests.scheduledBackup,
        ]),
        invalid: results.flatMap(({ row, result }) =>
            result.ok ? [] : [{ databaseId: row.database.id, errors: result.error }],
        ),
    };
}

export interface ReconcileReport {
    readonly applied: readonly ObjectRef[];
    readonly invalid: DatabasePlan['invalid'];
    readonly failed: readonly { readonly ref: ObjectRef; readonly error: KubeError }[];
}

export type ReconcileError =
    | { readonly kind: 'missing-backup-credentials'; readonly namespace: string; readonly name: string }
    | {
          readonly kind: 'incomplete-backup-credentials';
          readonly namespace: string;
          readonly name: string;
          readonly missingKeys: readonly string[];
      }
    | { readonly kind: 'kube'; readonly error: KubeError };

export interface ReconcileOptions {
    /** Where the platform's backup credentials Secret lives. */
    readonly backupCredentials: { readonly namespace: string; readonly name: string };
    /** Server-side dry run: the API server validates everything, nothing is stored. */
    readonly dryRun?: boolean;
    /** Where Projects' database tunnels run from (decision 126); without it, none is applied. */
    readonly tunnel?: TunnelSettings;
}

/** One pass: read the backup credentials, plan, apply. Never throws. */
export async function reconcileDatabases(
    kube: Kube,
    rows: readonly DatabaseRow[],
    config: DatabaseConfig,
    options: ReconcileOptions,
): Promise<Result<ReconcileReport, ReconcileError>> {
    const { namespace, name } = options.backupCredentials;
    const credentials = await kube.readSecret(namespace, name);
    if (!credentials.ok) {
        return err({ kind: 'kube', error: credentials.error });
    }
    if (credentials.value === undefined) {
        return err({ kind: 'missing-backup-credentials', namespace, name });
    }
    const missingKeys = Object.values(BACKUP_CREDENTIAL_KEYS).filter((key) => !credentials.value?.[key]);
    if (missingKeys.length > 0) {
        return err({ kind: 'incomplete-backup-credentials', namespace, name, missingKeys });
    }
    // Read before planning: without it every Cluster would be given the
    // `shared_buffers` of a new one, and a grown Database would restart. So
    // when they cannot be listed, no Cluster is applied in this pass; the
    // rest (namespaces, credentials, tunnels, Poolers) is.
    const clusters = await kube.listObjects('postgresql.cnpg.io/v1', 'Cluster', `${LABELS.managedBy}=${MANAGED_BY}`);
    const live = new Map(
        (clusters.ok ? clusters.value : []).map((cluster) => [liveClusterKey(cluster.metadata.namespace ?? '', cluster.metadata.name), liveClusterOf(cluster)]),
    );
    const plan = planDatabases(rows, config, credentials.value, options.tunnel, live);
    const dryRun = options.dryRun ?? false;

    // Chains run side by side, each in order: a namespace exists before its
    // Secret, an ObjectStore before its Cluster. Projects come first, so
    // every Database finds its namespace and credentials.
    const applyChain = async (chain: ApplyChain) => {
        const results: { ref: ObjectRef; result: Result<void, KubeError> }[] = [];
        for (const object of chain) {
            const held = object.kind === 'Cluster' && !clusters.ok;
            results.push({ ref: refOf(object), result: held ? err(clusters.error) : await kube.apply(object, { dryRun }) });
        }
        return results;
    };
    const applyAll = async (chains: readonly ApplyChain[]) => (await Promise.all(chains.map(applyChain))).flat();
    const outcomes = [...(await applyAll(plan.projects)), ...(await applyAll(plan.databases))];
    return ok({
        applied: outcomes.filter(({ result }) => result.ok).map(({ ref }) => ref),
        invalid: plan.invalid,
        failed: outcomes.flatMap(({ ref, result }) => (result.ok ? [] : [{ ref, error: result.error }])),
    });
}
