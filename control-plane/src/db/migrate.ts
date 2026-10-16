/**
 * Applies the SQL migrations in control-plane/migrations with node-pg-migrate.
 * The same files run from the CLI: `npm run migrate -w control-plane up`.
 */
import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

/** Runs every pending migration (or reverts all, for `down`); returns their names. */
export async function migrate(databaseUrl: string, direction: 'up' | 'down' = 'up'): Promise<readonly string[]> {
    const applied = await runner({
        databaseUrl,
        dir: MIGRATIONS_DIR,
        migrationsTable: 'pgmigrations',
        direction,
        count: Infinity,
        checkOrder: true,
        log: () => {},
    });
    return applied.map((migration) => migration.name);
}
