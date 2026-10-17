/**
 * The platform's own Account, Project and Database rows (`PLATFORM` in the
 * sdk). The bootstrap creates the control plane's Database from the same
 * ids; seeding the rows hands it over to the operator, which from then on
 * reconciles it like any customer's.
 */
import { PLATFORM } from '@openupstream/sdk';
import type pg from 'pg';

/** Inserts the rows that are missing, in one statement; never changes existing ones. */
export async function seedPlatform(pool: pg.Pool): Promise<void> {
    const { account, project, database } = PLATFORM;
    await pool.query(
        `with account as (
             insert into accounts (id, name, created_at) values ($1, $2, $3) on conflict (id) do nothing
         ), project as (
             insert into projects (id, account_id, name, created_at) values ($4, $1, $5, $6) on conflict (id) do nothing
         )
         insert into databases (id, project_id, name, home_site, memory_mb, storage_gb, created_at)
         values ($7, $4, $8, $9, $10, $11, $12) on conflict (id) do nothing`,
        [
            account.id,
            account.name,
            account.createdAt,
            project.id,
            project.name,
            project.createdAt,
            database.id,
            database.name,
            database.homeSite,
            database.memoryMb,
            database.storageGb,
            database.createdAt,
        ],
    );
}
