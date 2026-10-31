/**
 * openupstream control plane.
 *
 * Owns accounts, projects, databases, buckets, services, the routing table,
 * secrets, API keys and usage events. Provisions by writing rows that the
 * operators reconcile into Kubernetes objects; carries out deletes itself
 * (src/cleanup.ts) and renders the Projects' Secrets, whose key only it
 * holds (src/secrets/render.ts).
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
import { accessTokenVerifier, apiKeyVerifier, keysFrom, madauthAuthenticator, sessionVerifier } from './api/auth.js';
import { getAccountRecord, liftHold, placeHold } from './accounts/store.js';
import { s3BackupStore } from './backups.js';
import { cleanupPass } from './cleanup.js';
import { configFrom } from './config.js';
import { listDatabaseRows } from './databases/rows.js';
import { txtLookup } from './domains/dns.js';
import { ensureDefaultDomains } from './domains/store.js';
import { garageStorage } from './garage.js';
import { migrate } from './db/migrate.js';
import { tokenReviewAuthenticator } from './internal/auth.js';
import { createInternalServer } from './internal/server.js';
import { controlPlaneKube } from './kube.js';
import { seedPlatform } from './platform.js';
import { registryDeps } from './registry.js';
import { listDomainRoutings } from './routes/store.js';
import { secretsPass } from './secrets/render.js';
import { listServiceRows } from './services/store.js';

const log = (entry: Record<string, unknown>): void =>
    console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

/** Any numbers will do, as long as nothing else in this database uses them. */
const CLEANUP_LOCK = 7_310_001;
const SECRETS_LOCK = 7_310_002;

/**
 * Runs `pass` every interval until stopped. Both replicas run the loop; a
 * session advisory lock lets only one of them do a pass at a time. A failed
 * pass is logged and the next one retries.
 */
async function runExclusively(
    name: string,
    pool: pg.Pool,
    lock: number,
    pass: () => Promise<void>,
    intervalMs: number,
    signal: AbortSignal,
    log: (entry: Record<string, unknown>) => void,
): Promise<void> {
    while (!signal.aborted) {
        const connected = await pool.connect().then(
            (client) => ({ ok: true as const, client }),
            (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }),
        );
        if (!connected.ok) {
            // E.g. our Database is failing over: wait for the next pass.
            log({ msg: `${name} pass skipped: no database connection`, error: connected.error });
            await sleep(intervalMs, undefined, { signal }).catch(() => undefined);
            continue;
        }
        const { client } = connected;
        const attempt = client
            .query<{ locked: boolean }>('select pg_try_advisory_lock($1) as locked', [lock])
            .then(async ({ rows }) => {
                if (rows[0]?.locked === true) {
                    await pass().finally(() => client.query('select pg_advisory_unlock($1)', [lock]));
                }
            });
        await attempt.then(
            () => client.release(),
            (error: unknown) => {
                log({ msg: `${name} pass failed`, error: error instanceof Error ? error.message : String(error) });
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
    // A billing service needs its Database (ARCHITECTURE.md, decision 79).
    await seedPlatform(pool, { billing: config.value.billingCallers.size > 0 });
    const domains = await ensureDefaultDomains(pool, config.value.customerDomain);
    if (domains > 0) {
        log({ msg: 'default Domains created for existing Projects', domains });
    }

    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromDefault();
    const kube = controlPlaneKube(kubeConfig);
    const storage = garageStorage(config.value.garage);

    const internal = createInternalServer({
        authenticate: tokenReviewAuthenticator(kubeConfig, INTERNAL_API_AUDIENCE),
        allowedCallers: config.value.allowedCallers,
        billingCallers: config.value.billingCallers,
        routesCallers: config.value.routesCallers,
        servicesCallers: config.value.servicesCallers,
        listDatabaseRows: () => listDatabaseRows(pool),
        listDomainRoutings: () => listDomainRoutings(pool),
        listServiceRows: () => listServiceRows(pool),
        getAccount: (id) => getAccountRecord(pool, id),
        placeHold: (accountId, reason) => placeHold(pool, accountId, reason),
        liftHold: (accountId, reason) => liftHold(pool, accountId, reason),
        log,
    });
    internal.listen(config.value.internalPort);

    const madauthKeys = keysFrom(auth.jwks === undefined ? { jwksUrl: new URL('/.well-known/jwks.json', auth.madauthUrl).href } : { jwks: auth.jwks });
    const api = createApi({
        pool,
        kube,
        storage,
        kek: config.value.kek,
        registry: registryDeps(),
        customerDomain: config.value.customerDomain,
        platformDomain: config.value.platformDomain,
        lookupTxt: txtLookup(),
        newAccountHolds: config.value.newAccountHolds,
        ...(auth.cliClientId === undefined ? {} : { cliLogin: { issuer: auth.issuer, clientId: auth.cliClientId } }),
        authenticate: madauthAuthenticator(
            sessionVerifier({ issuer: auth.issuer, keys: madauthKeys }),
            apiKeyVerifier(auth.madauthUrl),
            accessTokenVerifier({ issuer: auth.issuer, keys: madauthKeys, clientIds: auth.cliClientId === undefined ? [] : [auth.cliClientId] }),
        ),
        log,
    });
    const server = serve({ fetch: api.fetch, port: config.value.port });
    log({
        msg: 'control plane listening',
        port: config.value.port,
        internalPort: config.value.internalPort,
        allowedCallers: [...config.value.allowedCallers],
        billingCallers: [...config.value.billingCallers],
        newAccountHolds: config.value.newAccountHolds,
    });

    const stop = new AbortController();
    process.once('SIGTERM', () => {
        stop.abort();
        server.close();
        internal.close();
    });
    const cleanupDeps = { pool, kube, backups: s3BackupStore(backup), storage, retention: backup.retention, log };
    const secretsDeps = { pool, kube, kek: config.value.kek, log };
    const interval = config.value.cleanupIntervalMs;
    await Promise.all([
        runExclusively('cleanup', pool, CLEANUP_LOCK, () => cleanupPass(cleanupDeps), interval, stop.signal, log),
        runExclusively('secrets', pool, SECRETS_LOCK, () => secretsPass(secretsDeps), interval, stop.signal, log),
    ]);
    await pool.end();
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    main().catch((error: unknown) => {
        log({ msg: 'control plane failed', error: error instanceof Error ? error.message : String(error) });
        process.exit(1);
    });
}
