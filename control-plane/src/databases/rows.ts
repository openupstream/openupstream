/**
 * Databases with their Projects, as the operators need them (the internal
 * API's `GET /internal/v1/databases`).
 */
import type { DatabaseRow, Site } from '@openupstream/sdk';
import type pg from 'pg';

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
    database_created_at: Date;
}

/** Every Database, oldest first, so the order is stable between calls. */
export async function listDatabaseRows(pool: pg.Pool): Promise<DatabaseRow[]> {
    const { rows } = await pool.query<Row>(`
        select p.id as project_id, p.account_id, p.name as project_name, p.created_at as project_created_at,
               d.id as database_id, d.name as database_name, d.home_site, d.memory_mb, d.storage_gb,
               d.created_at as database_created_at
        from databases d
        join projects p on p.id = d.project_id
        order by d.created_at, d.id`);
    return rows.map((row) => ({
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
            createdAt: row.database_created_at.toISOString(),
        },
    }));
}
