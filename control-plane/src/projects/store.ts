/**
 * Projects as the public API sees them: only live ones, only in the caller's
 * Accounts. Deleting marks the Project and its Databases deleted in one
 * statement; the cleanup (src/cleanup.ts) does the rest.
 */
import type { Project } from '@openupstream/sdk';
import type pg from 'pg';
import { unlessUnique } from '../db/errors.js';
import { type Result, ok } from '../result.js';

interface ProjectRow {
    id: string;
    account_id: string;
    name: string;
    created_at: Date;
}

const toProject = (row: ProjectRow): Project => ({
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    createdAt: row.created_at.toISOString(),
});

const COLUMNS = 'id, account_id, name, created_at';

export async function listProjects(pool: pg.Pool, accountIds: readonly string[]): Promise<Project[]> {
    const { rows } = await pool.query<ProjectRow>(
        `select ${COLUMNS} from projects where account_id = any($1) and deleted_at is null order by created_at, id`,
        [accountIds],
    );
    return rows.map(toProject);
}

export async function getProject(
    pool: pg.Pool,
    accountIds: readonly string[],
    id: string,
): Promise<Project | undefined> {
    const { rows } = await pool.query<ProjectRow>(
        `select ${COLUMNS} from projects where id = $1 and account_id = any($2) and deleted_at is null`,
        [id, accountIds],
    );
    return rows.map(toProject)[0];
}

export type CreateProjectError = { readonly kind: 'name-taken'; readonly name: string };

/** The caller must already be known to be a Member of `accountId`. */
export async function createProject(
    pool: pg.Pool,
    accountId: string,
    name: string,
): Promise<Result<Project, CreateProjectError>> {
    const inserted = await unlessUnique(
        pool.query<ProjectRow>(`insert into projects (account_id, name) values ($1, $2) returning ${COLUMNS}`, [
            accountId,
            name,
        ]),
        { kind: 'name-taken', name } as const,
    );
    // An insert … returning without a conflict always returns its row.
    return inserted.ok ? ok(toProject(inserted.value.rows[0] as ProjectRow)) : inserted;
}

/** Marks the Project and its live Databases deleted; false when there was no such live Project. */
export async function deleteProject(pool: pg.Pool, accountIds: readonly string[], id: string): Promise<boolean> {
    // A data-modifying CTE runs to completion whether or not the outer
    // query reads it, so the Databases are marked in the same statement.
    const { rowCount } = await pool.query(
        `with project as (
             update projects set deleted_at = now()
             where id = $1 and account_id = any($2) and deleted_at is null
             returning id, deleted_at
         ), databases as (
             update databases d set deleted_at = project.deleted_at
             from project where d.project_id = project.id and d.deleted_at is null
         )
         select id from project`,
        [id, accountIds],
    );
    return rowCount === 1;
}
