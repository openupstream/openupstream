/**
 * What people call each Site (ADR-0009): display text in the control
 * plane's Postgres, which the installation's admins change on the
 * dashboard. Which Sites exist and where things run stays the nodes'
 * labels' (ADR-0007).
 */
import type { Site } from '@openupstream/sdk';
import type pg from 'pg';

/** The longest description, as the schema allows it. */
export const MAX_DESCRIPTION_LENGTH = 100;

/** Every stored description, by Site id. */
export async function siteDescriptions(pool: pg.Pool): Promise<ReadonlyMap<Site, string>> {
    const { rows } = await pool.query<{ site: string; description: string }>('select site, description from site_descriptions');
    return new Map(rows.map((row) => [row.site, row.description]));
}

/** Sets a Site's description, or removes it with null, so the id is shown alone. */
export async function setSiteDescription(pool: pg.Pool, site: Site, description: string | null): Promise<void> {
    await (description === null
        ? pool.query('delete from site_descriptions where site = $1', [site])
        : pool.query(
              `insert into site_descriptions (site, description) values ($1, $2)
               on conflict (site) do update set description = excluded.description, updated_at = now()`,
              [site, description],
          ));
}
