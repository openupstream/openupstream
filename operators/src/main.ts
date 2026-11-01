/**
 * Entry point of the operators' container (operators/deploy). OPERATOR picks
 * which one this process runs, each as its own Deployment with its own
 * ServiceAccount, so each has only the rights it needs.
 *
 * Environment:
 * - OPERATOR: `databases` (default), `routes`, `services` or `jobs`
 * - CONTROL_PLANE_URL: the control plane's internal API, e.g.
 *   http://control-plane.project-<id>.svc:8081
 * - TOKEN_PATH: the projected ServiceAccount token for the control plane's
 *   audience
 * - INTERVAL_SECONDS: time between passes, default 30
 * - for `databases`: DATABASE_CONFIG_PATH, a DatabaseConfig as JSON (a
 *   ConfigMap), and BACKUP_CREDENTIALS, `<namespace>/<name>` of the backup
 *   credentials Secret
 * - for `routes`: CLUSTER_ISSUER, the ClusterIssuer of custom domains'
 *   certificates
 */
import { readFile } from 'node:fs/promises';
import { KubeConfig } from '@kubernetes/client-node';
import { controlPlaneJobs, controlPlaneRoutings, controlPlaneRows, controlPlaneServices } from './control-plane.js';
import { type PassLog, databasesPass, runPasses } from './databases/loop.js';
import type { DatabaseConfig } from './databases/manifests.js';
import { jobsPass } from './jobs/loop.js';
import { kubeFrom } from './kube.js';
import { routesPass } from './routes/loop.js';
import { servicesPass } from './services/loop.js';

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

const operator = process.env['OPERATOR'] ?? 'databases';
if (operator !== 'databases' && operator !== 'routes' && operator !== 'services' && operator !== 'jobs') {
    log({ msg: 'OPERATOR must be databases, routes, services or jobs', operator });
    process.exit(1);
}
const controlPlaneUrl = required('CONTROL_PLANE_URL');
const tokenPath = required('TOKEN_PATH');
const intervalSeconds = Number(process.env['INTERVAL_SECONDS'] ?? 30);
if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1) {
    log({ msg: 'INTERVAL_SECONDS must be a number of seconds, at least 1' });
    process.exit(1);
}
const intervalMs = intervalSeconds * 1000;

const kubeConfig = new KubeConfig();
kubeConfig.loadFromDefault();
const kube = kubeFrom(kubeConfig);
const token = () => readFile(tokenPath, 'utf8');

const databases = async (): Promise<() => Promise<PassLog>> => {
    const [credentialsNamespace, credentialsName] = required('BACKUP_CREDENTIALS').split('/');
    if (credentialsNamespace === undefined || credentialsName === undefined) {
        log({ msg: 'BACKUP_CREDENTIALS must be <namespace>/<name>' });
        process.exit(1);
    }
    const config: DatabaseConfig = JSON.parse(await readFile(required('DATABASE_CONFIG_PATH'), 'utf8'));
    const fetchRows = controlPlaneRows(controlPlaneUrl, token);
    return () =>
        databasesPass(fetchRows, kube, config, {
            backupCredentials: { namespace: credentialsNamespace, name: credentialsName },
        });
};
const routes = (): (() => Promise<PassLog>) => {
    const settings = { clusterIssuer: required('CLUSTER_ISSUER') };
    const fetchRoutings = controlPlaneRoutings(controlPlaneUrl, token);
    return () => routesPass(fetchRoutings, kube, settings);
};

const services = (): (() => Promise<PassLog>) => {
    const fetchServices = controlPlaneServices(controlPlaneUrl, token);
    return () => servicesPass(fetchServices, kube);
};

const jobs = (): (() => Promise<PassLog>) => {
    const fetchJobs = controlPlaneJobs(controlPlaneUrl, token);
    return () => jobsPass(fetchJobs, kube);
};

const passes = { databases, routes, services, jobs } as const;
const pass = await passes[operator]();
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
log({ msg: `${operator} operator started`, controlPlaneUrl, intervalMs });
await runPasses(pass, intervalMs, log, stop.signal);
