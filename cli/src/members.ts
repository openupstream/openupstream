/**
 * `oup member`: an Account's Members and their roles (ARCHITECTURE.md,
 * decisions 138 and 143). Pure, so it is tested without an API.
 */
import { MEMBER_ROLES, type Member, type MemberRole } from '@openupstream/sdk';
import { type Result, err, ok } from './result.js';

/** One line per Member: address, role, since when. */
export const formatMembers = (members: readonly Member[]): string[] =>
    members.map((member) => `${member.email.padEnd(32)} ${(member.role ?? '-').padEnd(10)} since ${member.createdAt.slice(0, 10)}`);

/** The Member with this address, ignoring case, as madAuth compares addresses. */
export const memberByEmail = (members: readonly Member[], email: string): Result<Member, string> => {
    const found = members.find((member) => member.email.toLowerCase() === email.toLowerCase());
    return found === undefined ? err(`no Member ${email} in this Account`) : ok(found);
};

export const parseRole = (value: string | undefined): Result<MemberRole, string> =>
    (MEMBER_ROLES as readonly string[]).includes(value ?? '')
        ? ok(value as MemberRole)
        : err(`the role must be one of ${MEMBER_ROLES.join(', ')}`);

/** Added to the API's 409 (the Account keeps an owner): the command that resolves it. */
export const LAST_OWNER_HINT = 'oup member role <email> owner gives another Member the role';
