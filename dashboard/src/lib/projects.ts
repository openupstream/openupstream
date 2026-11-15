import { type Account, DNS_LABEL, type Project } from '@openupstream/sdk';

/** What is wrong with a Project name, before the API is asked; undefined when nothing is. */
export const projectNameProblem = (name: string, existing: readonly Pick<Project, 'name'>[]): string | undefined =>
    !DNS_LABEL.test(name)
        ? 'Lowercase letters, digits and hyphens, starting with a letter, at most 63 characters, e.g. production.'
        : existing.some((project) => project.name === name)
          ? `A Project named ${name} exists.`
          : undefined;

/** Each Account with its Projects, by name; Accounts without Projects included. */
export const projectsByAccount = (
    accounts: readonly Account[],
    projects: readonly Project[],
): { readonly account: Account; readonly projects: readonly Project[] }[] =>
    accounts.map((account) => ({
        account,
        projects: projects.filter((project) => project.accountId === account.id).toSorted((a, b) => a.name.localeCompare(b.name)),
    }));
