/**
 * Entry point of the madAuth sidecar (src/madauth/sidecar.ts), run from the
 * control plane's image next to madAuth: `node control-plane/dist/madauth-sidecar.js`.
 *
 * Environment: WEBHOOK_SECRET (the same `whsec_…` madAuth signs with),
 * SIDECAR_PORT (default 8788), MAIL (`log` on the dev cluster; unset: no
 * mail sender, e-mails are refused).
 */
import { serve } from '@hono/node-server';
import { createSidecar, logMail } from './madauth/sidecar.js';

const log = (entry: Record<string, unknown>): void =>
    console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

const webhookSecret = process.env['WEBHOOK_SECRET'] ?? '';
const port = Number(process.env['SIDECAR_PORT'] ?? 8788);
if (!webhookSecret.startsWith('whsec_') || !Number.isInteger(port)) {
    log({ msg: 'WEBHOOK_SECRET (whsec_…) and a numeric SIDECAR_PORT are required' });
    process.exit(1);
}
const mail = process.env['MAIL'];
if (mail !== undefined && mail !== '' && mail !== 'log') {
    log({ msg: `MAIL=${mail} is not supported; only "log" (dev cluster)` });
    process.exit(1);
}

const app = createSidecar({ webhookSecret, sendMail: mail === 'log' ? logMail(log) : undefined, log });
// Only madAuth, in the same pod, may call it.
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
log({ msg: 'madauth sidecar listening', port, mail: mail ?? 'none' });
