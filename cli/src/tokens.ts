/**
 * `oup token`: an Account's tokens (ARCHITECTURE.md, decision 144). Pure, so
 * it is tested without an API.
 */
import { ACCOUNT_TOKEN_MAX_DAYS, ACCOUNT_TOKEN_ROLES, type AccountToken, type AccountTokenRole } from '@openupstream/sdk';
import { type Result, err, ok } from './result.js';

const DAY_MS = 86_400_000;

/**
 * One line per token: name, role, until when, last use, and its grants as
 * `project/database:level`.
 */
export const formatTokens = (tokens: readonly AccountToken[], now: Date): string[] =>
    tokens.map((token) => {
        const until = token.expiresAt.slice(0, 10);
        const expiry = new Date(token.expiresAt).getTime() <= now.getTime() ? `expired ${until}` : `until ${until}`;
        const used = token.lastUsedAt === null ? 'never used' : `used ${token.lastUsedAt.slice(0, 10)}`;
        const line = `${token.name.padEnd(24)} ${(token.role ?? '-').padEnd(10)} ${expiry.padEnd(18)} ${used}`;
        const grants = token.grants.map((grant) => `${grant.projectName}/${grant.databaseName}:${grant.access}`);
        return grants.length === 0 ? line : `${line}  ${grants.join(', ')}`;
    });

/** The token with this name. */
export const tokenByName = (tokens: readonly AccountToken[], name: string): Result<AccountToken, string> => {
    const found = tokens.find((token) => token.name === name);
    return found === undefined ? err(`no Account token ${name} in this Account`) : ok(found);
};

/** A role, or `none`: only what the token's grants give (null). Never owner. */
export const parseTokenRole = (value: string | undefined): Result<AccountTokenRole | null, string> =>
    value === 'none'
        ? ok(null)
        : (ACCOUNT_TOKEN_ROLES as readonly string[]).includes(value ?? '')
          ? ok(value as AccountTokenRole)
          : err(`an Account token's role is ${[...ACCOUNT_TOKEN_ROLES, 'none'].join(' or ')}; never owner`);

/**
 * `--expires`: a number of days (`90d`), a date (`2027-03-01`, its start in
 * UTC) or an RFC 3339 time; in the future and at most
 * ACCOUNT_TOKEN_MAX_DAYS away. The API checks that too.
 */
export const parseExpiry = (value: string | undefined, now: Date): Result<Date, string> => {
    if (value === undefined) {
        return err(`--expires is required: a number of days (90d) or a date, at most ${ACCOUNT_TOKEN_MAX_DAYS} days away`);
    }
    const days = /^(\d{1,4})d$/.exec(value)?.[1];
    const date =
        days !== undefined
            ? new Date(now.getTime() + Number(days) * DAY_MS)
            : /^\d{4}-\d{2}-\d{2}$/.test(value)
              ? new Date(`${value}T00:00:00Z`)
              : /^\d{4}-\d{2}-\d{2}T/.test(value)
                ? new Date(value)
                : undefined;
    if (date === undefined || Number.isNaN(date.getTime())) {
        return err(`--expires ${value}: a number of days (90d), a date (2027-03-01) or an RFC 3339 time`);
    }
    if (date.getTime() <= now.getTime()) {
        return err(`--expires ${value} is not in the future`);
    }
    return date.getTime() > now.getTime() + ACCOUNT_TOKEN_MAX_DAYS * DAY_MS
        ? err(`--expires ${value} is more than ${ACCOUNT_TOKEN_MAX_DAYS} days away; an Account token lasts a year at most`)
        : ok(date);
};
