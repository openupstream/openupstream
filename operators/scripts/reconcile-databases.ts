/**
 * One reconcile pass for Databases against the cluster in $KUBECONFIG, with
 * rows from a JSON file or the platform's own Database instead of the
 * control plane. For the bootstrap, which creates the control plane's
 * Database before there is a control plane, and the dev cluster
 * (infra/dev-cluster).
 *
 *   npx tsx scripts/reconcile-databases.ts (<rows.json> | --platform) <config.json> [--dry-run]
 *
 * rows.json is `[{ "project": Project, "database": Database }]`; config.json
 * is a DatabaseConfig. The backup credentials are read from the Secret
 * `openupstream-system/<config.backup.credentialsSecret>`. With --platform
 * the Databases' Home site is the default Site, read from the nodes' labels
 * (ADR-0007), which the install sets before this runs.
 */
import { readFileSync } from 'node:fs';
import { KubeConfig, KubernetesObjectApi } from '@kubernetes/client-node';
import { COMPUTE_SITE_LABEL, DEFAULT_SITE_LABEL, ZONE_LABEL, platformRows } from '@openupstream/sdk';
import { databaseConfigProblem, type DatabaseConfig } from '../src/databases/manifests.js';
import { type DatabaseRow, reconcileDatabases } from '../src/databases/reconcile.js';
import { kubeFrom } from '../src/kube.js';

const args = process.argv.slice(2);
const platform = args.includes('--platform');
const paths = args.filter((arg) => !arg.startsWith('--'));
const [rowsPath, configPath] = platform ? [undefined, paths[0]] : paths;
if ((!platform && rowsPath === undefined) || configPath === undefined) {
    console.error('usage: reconcile-databases.ts (<rows.json> | --platform) <config.json> [--dry-run]');
    process.exit(2);
}
const config: DatabaseConfig = JSON.parse(readFileSync(configPath, 'utf8'));
const problem = databaseConfigProblem(config);
if (problem !== undefined) {
    console.error(`${configPath}: ${problem}`);
    process.exit(1);
}

const kubeConfig = new KubeConfig();
kubeConfig.loadFromDefault();

/** The zone of the nodes labelled as the default compute Site; undefined when none is. */
const defaultSite = async (): Promise<string | undefined> => {
    const nodes = await KubernetesObjectApi.makeApiClient(kubeConfig).list(
        'v1',
        'Node',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        `${COMPUTE_SITE_LABEL}=true,${DEFAULT_SITE_LABEL}=true`,
    );
    return nodes.items.flatMap((node) => node.metadata?.labels?.[ZONE_LABEL] ?? []).sort()[0];
};

const homeSite = platform ? await defaultSite() : undefined;
if (platform && homeSite === undefined) {
    console.error(`no node is labelled ${COMPUTE_SITE_LABEL}=true,${DEFAULT_SITE_LABEL}=true; run install-multi-node.sh or install-single-node.sh`);
    process.exit(1);
}
const rows: DatabaseRow[] = homeSite !== undefined ? platformRows(homeSite) : JSON.parse(readFileSync(rowsPath ?? '', 'utf8'));

const result = await reconcileDatabases(kubeFrom(kubeConfig), rows, config, {
    backupCredentials: { namespace: 'openupstream-system', name: config.backup.credentialsSecret },
    dryRun: args.includes('--dry-run'),
});
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok && result.value.failed.length === 0 && result.value.invalid.length === 0 ? 0 : 1);
