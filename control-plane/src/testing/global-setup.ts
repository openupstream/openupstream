/**
 * Global setup for the test run (`node --test --test-global-setup`): starts
 * one Postgres server before any test file runs and hands it to all of them
 * as TEST_DATABASE_URL, so a local run starts one container instead of one
 * per file. With TEST_DATABASE_URL already set (CI), it uses that server.
 */
import { register } from 'tsx/esm/api';
import type { Server } from './postgres.js';

// The test runner's own process, where this module runs, ignores --import,
// so it registers tsx itself to load the TypeScript modules it imports.
register();
const { startServer } = await import('./postgres.js');

let server: Server | undefined;

export async function globalSetup(): Promise<void> {
    server = await startServer();
    process.env['TEST_DATABASE_URL'] = server.url;
}

export async function globalTeardown(): Promise<void> {
    await server?.stop();
}
