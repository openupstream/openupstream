/**
 * One reconcile pass for Databases against the cluster in $KUBECONFIG, with
 * rows from a JSON file instead of the control plane. For the dev cluster
 * (infra/dev-cluster).
 *
 *   npx tsx scripts/reconcile-databases.ts <rows.json> <config.json> [--dry-run]
 *
 * rows.json is `[{ "project": Project, "database": Database }]`; config.json
 * is a DatabaseConfig. The backup credentials are read from the Secret
 * `openupstream-system/<config.backup.credentialsSecret>`.
 */
import { readFileSync } from 'node:fs';
import { KubeConfig } from '@kubernetes/client-node';
import type { DatabaseConfig } from '../src/databases/manifests.js';
import { type DatabaseRow, reconcileDatabases } from '../src/databases/reconcile.js';
import { kubeFrom } from '../src/kube.js';

const args = process.argv.slice(2);
const [rowsPath, configPath] = args.filter((arg) => !arg.startsWith('--'));
if (rowsPath === undefined || configPath === undefined) {
    console.error('usage: reconcile-databases.ts <rows.json> <config.json> [--dry-run]');
    process.exit(2);
}
const rows: DatabaseRow[] = JSON.parse(readFileSync(rowsPath, 'utf8'));
const config: DatabaseConfig = JSON.parse(readFileSync(configPath, 'utf8'));

const kubeConfig = new KubeConfig();
kubeConfig.loadFromDefault();

const result = await reconcileDatabases(kubeFrom(kubeConfig), rows, config, {
    backupCredentials: { namespace: 'openupstream-system', name: config.backup.credentialsSecret },
    dryRun: args.includes('--dry-run'),
});
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok && result.value.failed.length === 0 && result.value.invalid.length === 0 ? 0 : 1);
