/**
 * Prints the manifests of one Database as YAML, for `kubectl apply` against a
 * dev cluster (infra/dev-cluster) or in a runbook. Not used by the operators
 * themselves.
 *
 *   npx tsx scripts/render-database.ts <project.json> <database.json> <config.json>
 *     [--restore-from <database id> --target-time <RFC 3339>]
 *
 * With --restore-from, the Database starts as a copy of that Database at the
 * target time (docs/runbooks/restore-from-backup.md).
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { stringify } from 'yaml';
import { databaseManifests, restoredDatabaseManifests } from '../src/databases/manifests.js';

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'restore-from': { type: 'string' }, 'target-time': { type: 'string' } },
});
const [projectPath, databasePath, configPath] = positionals;
const restoreFrom = values['restore-from'];
const targetTime = values['target-time'];
if (
    projectPath === undefined ||
    databasePath === undefined ||
    configPath === undefined ||
    (restoreFrom === undefined) !== (targetTime === undefined)
) {
    console.error(
        'usage: render-database.ts <project.json> <database.json> <config.json> [--restore-from <id> --target-time <time>]',
    );
    process.exit(2);
}
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const [project, database, config] = [read(projectPath), read(databasePath), read(configPath)];

const result =
    restoreFrom === undefined || targetTime === undefined
        ? databaseManifests(project, database, config)
        : // The source is in the same Project: its ObjectStore is read from this namespace.
          restoredDatabaseManifests(project, database, config, {
              database: { id: restoreFrom, projectId: project.id },
              targetTime,
          });
if (!result.ok) {
    console.error(JSON.stringify(result.error, null, 2));
    process.exit(1);
}
const { objectStore, cluster, pooler, scheduledBackup } = result.value;
process.stdout.write([objectStore, cluster, pooler, scheduledBackup].map((m) => stringify(m)).join('---\n'));
