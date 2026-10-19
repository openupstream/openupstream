/**
 * madAuth's e-mails, written and sent by the sidecar (ARCHITECTURE.md,
 * decision 66). madAuth decides when to send and provides the link and the
 * code; this module only puts them into words and hands them to Amazon SES.
 * Plain text, English, for now.
 */
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { type Result, err, ok } from '../result.js';
import type { MailRequest, SendMail } from './sidecar.js';

export interface Message {
    readonly subject: string;
    readonly text: string;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

const methodsOf = (value: unknown): string =>
    Array.isArray(value) && value.length > 0 ? value.filter((m) => typeof m === 'string').join(', ') : 'another method';

const footer = '\n\nIf you did not ask for this e-mail, you can ignore it.\n\nopenupstream';

/** The e-mail for one of madAuth's `email.send_*` calls, or why it cannot be written. */
export function compose(mail: MailRequest): Result<Message, string> {
    const link = str(mail.data['link']);
    const code = str(mail.data['code']);
    switch (mail.type) {
        case 'email.send_verification':
            return link === undefined || code === undefined
                ? err('verification without link or code')
                : ok({
                      subject: 'Confirm your e-mail address for openupstream',
                      text: `Confirm your e-mail address to finish signing up.\n\nOpen this link:\n${link}\n\nOr enter this code: ${code}${footer}`,
                  });
        case 'email.send_password_reset':
            return link === undefined || code === undefined
                ? err('password reset without link or code')
                : ok({
                      subject: 'Reset your openupstream password',
                      text: `Someone asked to reset the password of your openupstream account.\n\nOpen this link to choose a new one:\n${link}\n\nOr enter this code: ${code}${footer}`,
                  });
        case 'email.send_signin_link':
            return link === undefined || code === undefined
                ? err('sign-in link without link or code')
                : ok({
                      subject: 'Sign in to openupstream',
                      text: `Open this link to sign in:\n${link}\n\nOr enter this code: ${code}${footer}`,
                  });
        case 'email.send_already_registered':
            return ok({
                subject: 'You already have an openupstream account',
                text: `Someone tried to sign up with this address, which already has an account. You sign in with: ${methodsOf(mail.data['methods'])}.${link === undefined ? '' : `\n\nSign in here:\n${link}`}${footer}`,
            });
        case 'email.send_password_reset_no_password':
            return ok({
                subject: 'Your openupstream account has no password',
                text: `Someone asked to reset the password of your openupstream account, but it has none: you sign in with ${methodsOf(mail.data['methods'])}.${link === undefined ? '' : `\n\nSign in here:\n${link}`}${footer}`,
            });
        default:
            return err(`no e-mail for ${mail.type}`);
    }
}

/** The part of the SES client that sending needs, so tests can stand in for it. */
export interface SesSender {
    send(command: SendEmailCommand): Promise<unknown>;
}

export const sesClient = (region: string): SesSender => new SESv2Client({ region });

/** Sends through SES as `from`; the client takes the send-only key from AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY. */
export const sesMail =
    (client: SesSender, from: string): SendMail =>
    async (mail) => {
        const message = compose(mail);
        if (!message.ok) {
            return message;
        }
        const command = new SendEmailCommand({
            FromEmailAddress: from,
            Destination: { ToAddresses: [mail.to] },
            Content: {
                Simple: {
                    Subject: { Data: message.value.subject, Charset: 'UTF-8' },
                    Body: { Text: { Data: message.value.text, Charset: 'UTF-8' } },
                },
            },
        });
        return client.send(command).then(
            () => ok(undefined),
            (error: unknown) => err(`SES: ${error instanceof Error ? error.message : String(error)}`),
        );
    };
