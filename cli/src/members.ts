/**
 * `oup member`: an Account's Members, their roles and grants (ARCHITECTURE.md,
 * decisions 138, 139 and 143). Pure, so it is tested without an API.
 */
import { DATABASE_ACCESS_LEVELS, type DatabaseAccess, MEMBER_ROLES, type Member, type MemberRole } from '@openupstream/sdk';
import { type Result, err, ok } from './result.js';

/** One line per Member: address, role, since when, and their grants as `project/database:level`. */
export const formatMembers = (members: readonly Member[]): string[] =>
    members.map((member) => {
        const line = `${member.email.padEnd(32)} ${(member.role ?? '-').padEnd(10)} since ${member.createdAt.slice(0, 10)}`;
        const grants = member.grants.map((grant) => `${grant.projectName}/${grant.databaseName}:${grant.access}`);
        return grants.length === 0 ? line : `${line}  ${grants.join(', ')}`;
    });

/** The Member with this address, ignoring case, as madAuth compares addresses. */
export const memberByEmail = (members: readonly Member[], email: string): Result<Member, string> => {
    const found = members.find((member) => member.email.toLowerCase() === email.toLowerCase());
    return found === undefined ? err(`no Member ${email} in this Account`) : ok(found);
};

/** A role, or `none`: only what the Member's grants give (null). */
export const parseRole = (value: string | undefined): Result<MemberRole | null, string> =>
    value === 'none'
        ? ok(null)
        : (MEMBER_ROLES as readonly string[]).includes(value ?? '')
          ? ok(value as MemberRole)
          : err(`the role must be one of ${[...MEMBER_ROLES, 'none'].join(', ')}`);

/** A grant's level, given as a word after the address. */
export const parseGrantAccess = (value: string | undefined): Result<DatabaseAccess, string> =>
    (DATABASE_ACCESS_LEVELS as readonly string[]).includes(value ?? '')
        ? ok(value as DatabaseAccess)
        : err(`the level must be one of ${DATABASE_ACCESS_LEVELS.join(', ')}`);

/** Added to the API's 409 (the Account keeps an owner): the command that resolves it. */
export const LAST_OWNER_HINT = 'oup member role <email> owner gives another Member the role';
