// Reads an AWS secret access key on stdin and prints the Amazon SES SMTP
// password derived from it for `region`, as AWS documents it
// (https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html):
// node ses-smtp-password.mjs eu-central-1 < secret
// Alertmanager sends its e-mails over SES's SMTP interface with the
// send-only key madAuth's sidecar uses through the API (docs/self-hosting.md).
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const hmac = (key, message) => createHmac('sha256', key).update(message, 'utf8').digest();

/** The SMTP password of `secretAccessKey` in `region`: version byte 0x04, then the signature, in base64. */
export const smtpPassword = (secretAccessKey, region) => {
    const signature = ['11111111', region, 'ses', 'aws4_request', 'SendRawEmail'].reduce(hmac, Buffer.from(`AWS4${secretAccessKey}`, 'utf8'));
    return Buffer.concat([Buffer.from([0x04]), signature]).toString('base64');
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const region = process.argv[2];
    const secret = readFileSync(0, 'utf8').trim();
    if (region === undefined || secret === '') {
        console.error('usage: node ses-smtp-password.mjs <region> < secret-access-key');
        process.exit(1);
    }
    process.stdout.write(smtpPassword(secret, region));
}
