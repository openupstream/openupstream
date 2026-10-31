/**
 * Sending an e-mail through Amazon SES in an EU region (ARCHITECTURE.md,
 * decision 66), with a key that may only send as one address. The madAuth
 * sidecar sends madAuth's e-mails with it (src/madauth/mail.ts), the
 * control plane the waitlist's (src/waitlist). Plain text only.
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { type Result, err, ok } from './result.js';

export interface Message {
    readonly subject: string;
    readonly text: string;
}

/** The part of the SES client that sending needs, so tests can stand in for it. */
export interface SesSender {
    send(command: SendEmailCommand): Promise<unknown>;
}

/** The client takes the send-only key from AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY. */
export const sesClient = (region: string): SesSender => new SESv2Client({ region });

/** Sends `message` to `to` through SES as `from`; a refusal is an error, not an exception. */
export const sesSend =
    (client: SesSender, from: string) =>
    async (to: string, message: Message): Promise<Result<void, string>> => {
        const command = new SendEmailCommand({
            FromEmailAddress: from,
            Destination: { ToAddresses: [to] },
            Content: {
                Simple: {
                    Subject: { Data: message.subject, Charset: 'UTF-8' },
                    Body: { Text: { Data: message.text, Charset: 'UTF-8' } },
                },
            },
        });
        return client.send(command).then(
            () => ok(undefined),
            (error: unknown) => err(`SES: ${error instanceof Error ? error.message : String(error)}`),
        );
    };
