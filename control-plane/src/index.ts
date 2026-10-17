/**
 * openupstream control plane.
 *
 * Owns accounts, projects, databases, buckets, services, the routing table,
 * secrets, API keys and usage events. Provisions by writing rows that the
 * operators reconcile into Kubernetes objects; carries out deletes itself
 * (src/cleanup.ts).
 *
 * Two HTTP servers: the public API on PORT (src/api) and the internal API
 * for the operators on INTERNAL_PORT (src/internal). At startup it applies
 * pending migrations and seeds the platform's own rows. Settings:
 * src/config.ts.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { KubeConfig } from '@kubernetes/client-node';
import { INTERNAL_API_AUDIENCE } from '@openupstream/sdk';
import pg from 'pg';
import { createApi } from './api/app.js';
import { apiKeyVerifier, keysFrom, madauthAuthenticator, sessionVerifier } from './api/auth.js';
import { s3BackupStore } from './backups.js';
import { type CleanupDeps, cleanupPass } from './cleanup.js';
import { configFrom } from './config.js';
import { listDatabaseRows } from './databases/rows.js';
import { migrate } from './db/migrate.js';
import { tokenReviewAuthenticator } from './internal/auth.js';
import { createInternalServer } from './internal/server.js';
import { controlPlaneKube } from './kube.js';
import { seedPlatform } from './platform.js';

const log = (entry: Record<string, unknown>): void =>
    console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

/** Any number will do, as long as nothing else in this database uses it. */
const CLEANUP_LOCK = 7_310_001;

/**
 * Both replicas run the loop; a session advisory lock lets only one of them
 * do a pass at a time. A failed pass is logged and the next one retries.
 */
async function runCleanup(deps: CleanupDeps, intervalMs: number, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
        const connected = await deps.pool.connect().then(
            (client) => ({ ok: true as const, client }),
            (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
        );
        if (!connected.ok) {
            // E.g. our Database is failing over: wait for the next pass.
            deps.log({ msg: 'cleanup pass skipped: no database connection', error: connected.error });
            await sleep(intervalMs, undefined, { signal }).catch(() => undefined);
            continue;
        }
        const { client } = connected;
        const pass = client
            .query<{ locked: boolean }>('select pg_try_advisory_lock($1) as locked', [CLEANUP_LOCK])
            .then(async ({ rows }) => {
                if (rows[0]?.locked === true) {
                    await cleanupPass(deps).finally(() => client.query('select pg_advisory_unlock($1)', [CLEANUP_LOCK]));
                }
            });
        await pass.then(
            () => client.release(),
            (error: unknown) => {
                deps.log({ msg: 'cleanup pass failed', error: error instanceof Error ? error.message : String(error) });
                // The connection may hold the lock in an unknown state; do not reuse it.
                client.release(true);
            },
        );
        await sleep(intervalMs, undefined, { signal }).catch(() => undefined);
    }
}

async function main(): Promise<void> {
    const config = configFrom(process.env);
    if (!config.ok) {
        log({ msg: 'invalid configuration', problems: config.error });
        process.exit(1);
    }
    const { databaseUrl, auth, backup } = config.value;
    const applied = await migrate(databaseUrl);
    log({ msg: 'migrations applied', applied });
    const pool = new pg.Pool({ connectionString: databaseUrl });
    // A failover or switchover of our Database ends idle connections; without
    // a listener the pool's 'error' event would end the process.
    pool.on('error', (error) => log({ msg: 'idle database connection lost', error: error.message }));
    await seedPlatform(pool);

    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromDefault();
    const kube = controlPlaneKube(kubeConfig);

    const internal = createInternalServer({
        authenticate: tokenReviewAuthenticator(kubeConfig, INTERNAL_API_AUDIENCE),
        allowedCallers: config.value.allowedCallers,
        listDatabaseRows: () => listDatabaseRows(pool),
        log,
    });
    internal.listen(config.value.internalPort);

    const api = createApi({
        pool,
        kube,
        authenticate: madauthAuthenticator(
            sessionVerifier({
                issuer: auth.issuer,
                keys: keysFrom(auth.jwks === undefined ? { jwksUrl: new URL('/.well-known/jwks.json', auth.madauthUrl).href } : { jwks: auth.jwks }),
            }),
            apiKeyVerifier(auth.madauthUrl),
        ),
        log,
    });
    const server = serve({ fetch: api.fetch, port: config.value.port });
    log({
        msg: 'control plane listening',
        port: config.value.port,
        internalPort: config.value.internalPort,
        allowedCallers: [...config.value.allowedCallers],
    });

    const stop = new AbortController();
    process.once('SIGTERM', () => {
        stop.abort();
        server.close();
        internal.close();
    });
    await runCleanup(
        {
            pool,
            kube,
            backups: s3BackupStore(backup),
            retention: backup.retention,
            log,
        },
        config.value.cleanupIntervalMs,
        stop.signal,
    );
    await pool.end();
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    main().catch((error: unknown) => {
        log({ msg: 'control plane failed', error: error instanceof Error ? error.message : String(error) });
        process.exit(1);
    });
}
