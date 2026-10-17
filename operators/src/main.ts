/**
 * Entry point of the operators' container (operators/deploy). Runs the
 * Databases operator; the others join here as they are built.
 *
 * Environment:
 * - CONTROL_PLANE_URL: the control plane's internal API, e.g.
 *   http://control-plane.project-<id>.svc:8081
 * - TOKEN_PATH: the projected ServiceAccount token for the control plane's
 *   audience
 * - DATABASE_CONFIG_PATH: a DatabaseConfig as JSON (a ConfigMap)
 * - BACKUP_CREDENTIALS: `<namespace>/<name>` of the backup credentials Secret
 * - INTERVAL_SECONDS: time between passes, default 30
 */
import { readFile } from 'node:fs/promises';
import { KubeConfig } from '@kubernetes/client-node';
import { controlPlaneRows } from './control-plane.js';
import { databasesPass, runDatabasesOperator } from './databases/loop.js';
import type { DatabaseConfig } from './databases/manifests.js';
import { kubeFrom } from './kube.js';

const log = (entry: Record<string, unknown>): void =>
    console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

const required = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === '') {
        log({ msg: `${name} is not set` });
        process.exit(1);
    }
    return value;
};

const controlPlaneUrl = required('CONTROL_PLANE_URL');
const tokenPath = required('TOKEN_PATH');
const [credentialsNamespace, credentialsName] = required('BACKUP_CREDENTIALS').split('/');
if (credentialsNamespace === undefined || credentialsName === undefined) {
    log({ msg: 'BACKUP_CREDENTIALS must be <namespace>/<name>' });
    process.exit(1);
}
const config: DatabaseConfig = JSON.parse(await readFile(required('DATABASE_CONFIG_PATH'), 'utf8'));
const intervalMs = Number(process.env['INTERVAL_SECONDS'] ?? 30) * 1000;

const kubeConfig = new KubeConfig();
kubeConfig.loadFromDefault();
const kube = kubeFrom(kubeConfig);
const fetchRows = controlPlaneRows(controlPlaneUrl, () => readFile(tokenPath, 'utf8'));

const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
log({ msg: 'databases operator started', controlPlaneUrl, intervalMs });
await runDatabasesOperator(
    () =>
        databasesPass(fetchRows, kube, config, {
            backupCredentials: { namespace: credentialsNamespace, name: credentialsName },
        }),
    intervalMs,
    log,
    stop.signal,
);
