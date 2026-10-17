/**
 * The control plane's internal API, which only the operators call
 * (ARCHITECTURE.md, "Operators"). Not part of the public API: it is served
 * on its own port, never routed by ingress, and callers authenticate with
 * their Kubernetes ServiceAccount token.
 */
import type { Account, Database, Id, Project } from './model.js';

/**
 * Kubernetes names, by id (ARCHITECTURE.md, decision 42): the operators
 * create these objects, the control plane reads and deletes them.
 */
export const projectNamespace = (projectId: Id): string => `project-${projectId}`;

/** The Database's CloudNativePG Cluster; also its ObjectStore, ScheduledBackup and backup folder. */
export const clusterName = (database: Pick<Database, 'id'>): string => `db-${database.id}`;

/** Cannot share the Cluster's name, nor `<cluster>-rw`, which the Cluster's own Service takes. */
export const poolerName = (database: Pick<Database, 'id'>): string => `${clusterName(database)}-pooler`;

/** The folder under the backup bucket that holds one Database's base backups and WAL. */
export const backupPrefix = (projectId: Id, databaseId: Id): string =>
    `${projectNamespace(projectId)}/${clusterName({ id: databaseId })}/`;

/** Audience of the ServiceAccount tokens the operators send. */
export const INTERNAL_API_AUDIENCE = 'openupstream-control-plane';

/** `GET` lists every Database with its Project. */
export const INTERNAL_DATABASES_PATH = '/internal/v1/databases';

export interface DatabaseRow {
    readonly project: Project;
    readonly database: Database;
}

/**
 * The platform's own Account, Project and Database: the control plane's
 * state. The bootstrap creates this Database once; the control plane seeds
 * these rows at startup, and from then on the operator reconciles it like
 * any customer's. Fixed ids, so bootstrap and control plane agree.
 */
export const PLATFORM = {
    account: {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'openupstream',
        createdAt: '2026-10-17T00:00:00Z',
    },
    project: {
        id: '00000000-0000-4000-8000-000000000002',
        accountId: '00000000-0000-4000-8000-000000000001',
        name: 'platform',
        createdAt: '2026-10-17T00:00:00Z',
    },
    database: {
        id: '00000000-0000-4000-8000-000000000003',
        projectId: '00000000-0000-4000-8000-000000000002',
        name: 'control-plane',
        homeSite: 'hetzner-fsn1',
        memoryMb: 512,
        storageGb: 5,
        createdAt: '2026-10-17T00:00:00Z',
    },
} as const satisfies { account: Account; project: Project; database: Database };
