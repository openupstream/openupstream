/**
 * openupstream control plane.
 *
 * Owns accounts, projects, databases, buckets, services, the routing table,
 * secrets, API keys and usage events. Provisions by writing Kubernetes
 * objects and leaving reconciliation to the operators.
 *
 * Two HTTP servers: the public API on PORT (only a health check so far) and
 * the internal API for the operators on INTERNAL_PORT. At startup it applies
 * pending migrations and seeds the platform's own rows.
 */
import { createServer } from 'node:http';
import { KubeConfig } from '@kubernetes/client-node';
import { INTERNAL_API_AUDIENCE } from '@openupstream/sdk';
import pg from 'pg';
import { listDatabaseRows } from './databases/rows.js';
import { migrate } from './db/migrate.js';
import { tokenReviewAuthenticator } from './internal/auth.js';
import { createInternalServer } from './internal/server.js';
import { seedPlatform } from './platform.js';

const port = Number(process.env['PORT'] ?? 8080);
const internalPort = Number(process.env['INTERNAL_PORT'] ?? 8081);

/** The ServiceAccounts the internal API answers by default. */
export const DEFAULT_ALLOWED_CALLERS = ['system:serviceaccount:openupstream-system:databases-operator'];

const log = (entry: Record<string, unknown>): void => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

export function startServer(): ReturnType<typeof createServer> {
    const server = createServer((req, res) => {
        if (req.url === '/v1/health') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    server.listen(port);
    return server;
}

async function main(): Promise<void> {
    const databaseUrl = process.env['DATABASE_URL'];
    if (databaseUrl === undefined) {
        log({ msg: 'DATABASE_URL is not set' });
        process.exit(1);
    }
    const applied = await migrate(databaseUrl);
    log({ msg: 'migrations applied', applied });
    const pool = new pg.Pool({ connectionString: databaseUrl });
    await seedPlatform(pool);

    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromDefault();
    const allowedCallers = new Set(
        (process.env['ALLOWED_CALLERS'] ?? DEFAULT_ALLOWED_CALLERS.join(',')).split(',').filter((name) => name !== ''),
    );
    const internal = createInternalServer({
        authenticate: tokenReviewAuthenticator(kubeConfig, INTERNAL_API_AUDIENCE),
        allowedCallers,
        listDatabaseRows: () => listDatabaseRows(pool),
        log,
    });
    internal.listen(internalPort);
    const server = startServer();
    log({ msg: 'control plane listening', port, internalPort, allowedCallers: [...allowedCallers] });

    process.once('SIGTERM', () => {
        server.close();
        internal.close();
        void pool.end();
    });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    main().catch((error: unknown) => {
        log({ msg: 'control plane failed to start', error: error instanceof Error ? error.message : String(error) });
        process.exit(1);
    });
}
