/**
 * Entry point of the madAuth sidecar (src/madauth/sidecar.ts), run from the
 * control plane's image next to madAuth: `node control-plane/dist/madauth-sidecar.js`.
 *
 * Environment: WEBHOOK_SECRET (the same `whsec_…` madAuth signs with),
 * SIDECAR_PORT (default 8788), MAIL:
 * - `ses`: send through Amazon SES (src/madauth/mail.ts) as MAIL_FROM, in
 *   SES_REGION, with the send-only key in AWS_ACCESS_KEY_ID and
 *   AWS_SECRET_ACCESS_KEY;
 * - `log`: write the e-mails to the log instead (dev cluster, tests);
 * - unset: no mail sender, e-mails are refused.
 */
import { serve } from '@hono/node-server';
import { sesClient, sesMail } from './madauth/mail.js';
import { type SendMail, createSidecar, logMail } from './madauth/sidecar.js';

const log = (entry: Record<string, unknown>): void =>
    console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

const webhookSecret = process.env['WEBHOOK_SECRET'] ?? '';
const port = Number(process.env['SIDECAR_PORT'] ?? 8788);
if (!webhookSecret.startsWith('whsec_') || !Number.isInteger(port)) {
    log({ msg: 'WEBHOOK_SECRET (whsec_…) and a numeric SIDECAR_PORT are required' });
    process.exit(1);
}
const mail = process.env['MAIL'] ?? '';
const mailFrom = process.env['MAIL_FROM'] ?? '';
const sesRegion = process.env['SES_REGION'] ?? '';
const sendMail = ((): SendMail | undefined => {
    switch (mail) {
        case 'ses':
            if (mailFrom === '' || sesRegion === '' || process.env['AWS_ACCESS_KEY_ID'] === undefined) {
                log({ msg: 'MAIL=ses needs MAIL_FROM, SES_REGION and AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY' });
                process.exit(1);
            }
            return sesMail(sesClient(sesRegion), mailFrom);
        case 'log':
            return logMail(log);
        case '':
            return undefined;
        default:
            log({ msg: `MAIL=${mail} is not supported: ses, log, or unset` });
            process.exit(1);
    }
})();

const app = createSidecar({ webhookSecret, sendMail, log });
// Only madAuth, in the same pod, may call it.
serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
log({ msg: 'madauth sidecar listening', port, mail: mail === '' ? 'none' : mail, ...(mail === 'ses' ? { from: mailFrom, region: sesRegion } : {}) });
