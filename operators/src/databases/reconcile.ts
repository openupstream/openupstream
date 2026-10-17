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
 * the backup credentials, applies the plan with server-side apply and reports.
 */
import type { Database, Project } from '@openupstream/sdk';
import { type Kube, type KubeError, type KubeObject, type ObjectRef, refOf } from '../kube.js';
import { LABELS, MANAGED_BY, projectNamespace } from '../kubernetes.js';
import { type Result, err, ok } from '../result.js';
import { type DatabaseConfig, type DatabaseManifestError, databaseManifests } from './manifests.js';

export interface DatabaseRow {
    readonly project: Project;
    readonly database: Database;
}

export interface DatabasePlan {
    /** Namespaces and backup credentials first, then each Database's objects. */
    readonly apply: readonly KubeObject[];
    /** Rows that cannot run; their existing objects are left alone. */
    readonly invalid: readonly { readonly databaseId: string; readonly errors: readonly DatabaseManifestError[] }[];
}

const namespaceFor = (project: Project): KubeObject => ({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: {
        name: projectNamespace(project.id),
        labels: {
            [LABELS.projectId]: project.id,
            [LABELS.projectName]: project.name,
            [LABELS.managedBy]: MANAGED_BY,
        },
    },
});

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
 * What to apply so the cluster runs every Database in `rows`.
 * `backupCredentials` is the `data` of the platform's backup credentials
 * Secret.
 */
export function planDatabases(
    rows: readonly DatabaseRow[],
    config: DatabaseConfig,
    backupCredentials: Readonly<Record<string, string>>,
): DatabasePlan {
    const results = rows.map((row) => ({ row, result: databaseManifests(row.project, row.database, config) }));
    const valid = results.flatMap(({ row, result }) => (result.ok ? [{ row, manifests: result.value }] : []));
    const projects = uniqueBy(
        valid.map(({ row }) => row.project),
        (project) => project.id,
    );
    return {
        apply: [
            ...projects.map(namespaceFor),
            ...projects.map((project) => backupSecretFor(project, config, backupCredentials)),
            ...valid.flatMap(({ manifests }) => [
                manifests.objectStore,
                manifests.cluster,
                manifests.pooler,
                manifests.scheduledBackup,
            ]),
        ],
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
    | { readonly kind: 'kube'; readonly error: KubeError };

export interface ReconcileOptions {
    /** Where the platform's backup credentials Secret lives. */
    readonly backupCredentials: { readonly namespace: string; readonly name: string };
    /** Server-side dry run: the API server validates everything, nothing is stored. */
    readonly dryRun?: boolean;
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
    const plan = planDatabases(rows, config, credentials.value);
    const dryRun = options.dryRun ?? false;

    // One at a time, in order: a Cluster's namespace, Secret and ObjectStore
    // exist before the Cluster.
    const outcomes: { ref: ObjectRef; result: Result<void, KubeError> }[] = [];
    for (const object of plan.apply) {
        outcomes.push({ ref: refOf(object), result: await kube.apply(object, { dryRun }) });
    }
    return ok({
        applied: outcomes.filter(({ result }) => result.ok).map(({ ref }) => ref),
        invalid: plan.invalid,
        failed: outcomes.flatMap(({ ref, result }) => (result.ok ? [] : [{ ref, error: result.error }])),
    });
}
