/**
 * Databases of one Project as the public API sees them: only live ones.
 * Callers check first that the Project is live and the caller's
 * (projects/store.ts). Deleting only marks the row; the cleanup
 * (src/cleanup.ts) removes the Kubernetes objects and, after the retention
 * window, the backups and the row.
 */
import type { Database, DatabaseInput, Site } from '@openupstream/sdk';
import type pg from 'pg';
import { ACCOUNT_HELD, UNIQUE_VIOLATION, unlessCodes } from '../db/errors.js';
import { type Result, ok } from '../result.js';

interface DatabaseRow {
    id: string;
    project_id: string;
    name: string;
    home_site: Site;
    memory_mb: number;
    storage_gb: number;
    created_at: Date;
}

const toDatabase = (row: DatabaseRow): Database => ({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    homeSite: row.home_site,
    memoryMb: row.memory_mb,
    storageGb: row.storage_gb,
    createdAt: row.created_at.toISOString(),
});

const COLUMNS = 'id, project_id, name, home_site, memory_mb, storage_gb, created_at';

export async function listDatabases(pool: pg.Pool, projectId: string): Promise<Database[]> {
    const { rows } = await pool.query<DatabaseRow>(
        `select ${COLUMNS} from databases where project_id = $1 and deleted_at is null order by created_at, id`,
        [projectId],
    );
    return rows.map(toDatabase);
}

export async function getDatabase(pool: pg.Pool, projectId: string, id: string): Promise<Database | undefined> {
    const { rows } = await pool.query<DatabaseRow>(
        `select ${COLUMNS} from databases where id = $1 and project_id = $2 and deleted_at is null`,
        [id, projectId],
    );
    return rows.map(toDatabase)[0];
}

export type CreateDatabaseError = { readonly kind: 'name-taken'; readonly name: string } | { readonly kind: 'held' };

/** `input` is validated by the API; the schema enforces the same rules again. */
export async function createDatabase(
    pool: pg.Pool,
    projectId: string,
    input: DatabaseInput,
): Promise<Result<Database, CreateDatabaseError>> {
    const inserted = await unlessCodes<pg.QueryResult<DatabaseRow>, CreateDatabaseError>(
        pool.query<DatabaseRow>(
            `insert into databases (project_id, name, home_site, memory_mb, storage_gb)
             values ($1, $2, coalesce($3, 'hetzner-fsn1'), $4, $5) returning ${COLUMNS}`,
            [projectId, input.name, input.homeSite ?? null, input.memoryMb, input.storageGb],
        ),
        { [UNIQUE_VIOLATION]: { kind: 'name-taken', name: input.name }, [ACCOUNT_HELD]: { kind: 'held' } },
    );
    // An insert … returning without a conflict always returns its row.
    return inserted.ok ? ok(toDatabase(inserted.value.rows[0] as DatabaseRow)) : inserted;
}

/** Marks the Database deleted; false when there was no such live Database. */
export async function deleteDatabase(pool: pg.Pool, projectId: string, id: string): Promise<boolean> {
    const { rowCount } = await pool.query(
        'update databases set deleted_at = now() where id = $1 and project_id = $2 and deleted_at is null',
        [id, projectId],
    );
    return rowCount === 1;
}
