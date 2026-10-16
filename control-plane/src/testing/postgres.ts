/**
 * A fresh, migrated database for each test suite.
 *
 * Uses the Postgres server at TEST_DATABASE_URL when it is set (CI runs one
 * as a service container); otherwise starts one in Docker with
 * testcontainers. Each call creates its own database on that server and drops
 * it again on close, so test files can run in parallel.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from '../db/migrate.js';

const POSTGRES_IMAGE = 'postgres:17-alpine';

export interface TestDatabase {
    readonly url: string;
    readonly pool: pg.Pool;
    close(): Promise<void>;
}

interface Server {
    readonly url: string;
    stop(): Promise<void>;
}

async function startServer(): Promise<Server> {
    const configured = process.env['TEST_DATABASE_URL'];
    if (configured) {
        return { url: configured, stop: async () => {} };
    }
    const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
    return {
        url: container.getConnectionUri(),
        stop: async () => {
            await container.stop();
        },
    };
}

async function onServer(serverUrl: string, sql: string): Promise<void> {
    const client = new pg.Client({ connectionString: serverUrl });
    await client.connect();
    await client.query(sql);
    await client.end();
}

export async function createTestDatabase(): Promise<TestDatabase> {
    const server = await startServer();
    const name = `openupstream_test_${randomBytes(6).toString('hex')}`;
    await onServer(server.url, `create database ${name}`);

    const url = new URL(server.url);
    url.pathname = `/${name}`;
    await migrate(url.toString());
    const pool = new pg.Pool({ connectionString: url.toString() });

    return {
        url: url.toString(),
        pool,
        close: async () => {
            await pool.end();
            await onServer(server.url, `drop database ${name} with (force)`);
            await server.stop();
        },
    };
}
