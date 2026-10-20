/**
 * The platform's own Account, Project and Database rows (`PLATFORM` in the
 * sdk): the control plane's Database and madAuth's, and the billing
 * service's where one runs. The bootstrap creates the first two from the
 * same ids; seeding the rows hands them over to the operator, which from
 * then on reconciles them like any customer's. The billing Database has no
 * bootstrap: the operator creates it from the seeded row.
 */
import { PLATFORM } from '@openupstream/sdk';
import type pg from 'pg';

/** Inserts the rows that are missing, in one statement; never changes or removes existing ones. */
export async function seedPlatform(pool: pg.Pool, options: { readonly billing: boolean }): Promise<void> {
    const { account, project, database, authDatabase, billingDatabase } = PLATFORM;
    const databases = options.billing ? [database, authDatabase, billingDatabase] : [database, authDatabase];
    await pool.query(
        `with account as (
             insert into accounts (id, name, created_at) values ($1, $2, $3) on conflict (id) do nothing
         ), project as (
             insert into projects (id, account_id, name, created_at) values ($4, $1, $5, $6) on conflict (id) do nothing
         )
         insert into databases (id, project_id, name, home_site, memory_mb, storage_gb, created_at)
         select * from jsonb_to_recordset($7::jsonb)
             as d(id uuid, project_id uuid, name text, home_site text, memory_mb int, storage_gb int, created_at timestamptz)
         on conflict (id) do nothing`,
        [
            account.id,
            account.name,
            account.createdAt,
            project.id,
            project.name,
            project.createdAt,
            JSON.stringify(
                databases.map((d) => ({
                    id: d.id,
                    project_id: project.id,
                    name: d.name,
                    home_site: d.homeSite,
                    memory_mb: d.memoryMb,
                    storage_gb: d.storageGb,
                    created_at: d.createdAt,
                })),
            ),
        ],
    );
}
