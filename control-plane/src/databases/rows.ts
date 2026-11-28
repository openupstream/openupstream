/**
 * Databases with their Projects, as the operators need them (the internal
 * API's `GET /internal/v1/databases`), with the callers' own roles in each
 * and, for a Project that has any, its tunnel host (decision 126).
 */
import { type DatabaseRow, type Site, tunnelHostname } from '@openupstream/sdk';
import type pg from 'pg';
import { rolesByDatabase } from './roles.js';
import { restoreOf } from './store.js';

interface Row {
    project_id: string;
    account_id: string;
    project_name: string;
    project_created_at: Date;
    database_id: string;
    database_name: string;
    home_site: Site;
    memory_mb: number;
    storage_gb: number;
    auto_grow: boolean;
    max_storage_gb: number | null;
    database_created_at: Date;
    app_credentials: boolean;
    restore_source_id: string | null;
    restore_target_time: Date | null;
    restore_finished_at: Date | null;
}

/**
 * Every Database that is not deleted, oldest first, so the order is stable
 * between calls. Without `customerDomain` no row names a tunnel host.
 */
export async function listDatabaseRows(pool: pg.Pool, customerDomain?: string): Promise<DatabaseRow[]> {
    const roles = await rolesByDatabase(pool);
    const { rows } = await pool.query<Row>(`
        select p.id as project_id, p.account_id, p.name as project_name, p.created_at as project_created_at,
               d.id as database_id, d.name as database_name, d.home_site, d.memory_mb, d.storage_gb, d.auto_grow, d.max_storage_gb,
               d.created_at as database_created_at, d.restore_source_id, d.restore_target_time, d.restore_finished_at,
               d.app_password is not null as app_credentials
        from databases d
        join projects p on p.id = d.project_id
        where d.deleted_at is null
        order by d.created_at, d.id`);
    const withRoles = new Set(rows.filter((row) => roles.has(row.database_id)).map((row) => row.project_id));
    return rows.map((row) => {
        const databaseRoles = roles.get(row.database_id);
        return {
            project: {
                id: row.project_id,
                accountId: row.account_id,
                name: row.project_name,
                createdAt: row.project_created_at.toISOString(),
            },
            database: {
                id: row.database_id,
                projectId: row.project_id,
                name: row.database_name,
                homeSite: row.home_site,
                memoryMb: row.memory_mb,
                storageGb: row.storage_gb,
                autoGrow: row.auto_grow,
                maxStorageGb: row.max_storage_gb,
                createdAt: row.database_created_at.toISOString(),
                ...restoreOf(row),
            },
            ...(row.restore_source_id !== null && row.restore_finished_at === null ? { restoring: true } : {}),
            ...(databaseRoles === undefined ? {} : { roles: databaseRoles }),
            ...(row.app_credentials ? { appCredentials: true } : {}),
            ...(customerDomain !== undefined && withRoles.has(row.project_id) ? { tunnelHostname: tunnelHostname(row.project_id, customerDomain) } : {}),
        };
    });
}
