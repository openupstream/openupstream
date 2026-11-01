/**
 * Which Project a command acts on. `oup link <project>` writes the Project's
 * id into `.openupstream.json` in the current directory; later commands in
 * that directory or below it find the file, as git finds `.git`. `--project`
 * (or `OUP_PROJECT`, for CI) names a Project for one command instead.
 *
 * The file holds the id, not the name, so renaming the Project does not
 * break it, and no secret: it may be committed.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Project } from '@openupstream/sdk';
import { parseJson } from './json.js';
import { type Result, err, ok } from './result.js';

export const LINK_FILE = '.openupstream.json';

export interface ProjectLink {
    readonly projectId: string;
    /** For people reading the file; the id is what counts. */
    readonly project: string;
}

const isLink = (value: unknown): value is ProjectLink =>
    typeof value === 'object' &&
    value !== null &&
    'projectId' in value &&
    typeof value.projectId === 'string' &&
    'project' in value &&
    typeof value.project === 'string';

/** The nearest link file at `dir` or above, with where it is; undefined when there is none. */
export async function findLink(dir: string): Promise<Result<{ readonly path: string; readonly link: ProjectLink } | undefined, string>> {
    const path = join(dir, LINK_FILE);
    const text = await readFile(path, 'utf8').catch(() => undefined);
    if (text !== undefined) {
        const link = parseJson(text);
        return isLink(link) ? ok({ path, link }) : err(`${path} is not a Project link; run oup link <project> again`);
    }
    const parent = dirname(dir);
    return parent === dir ? ok(undefined) : findLink(parent);
}

export async function writeLink(dir: string, project: Project): Promise<string> {
    const path = join(dir, LINK_FILE);
    const link: ProjectLink = { projectId: project.id, project: project.name };
    await writeFile(path, `${JSON.stringify(link, null, 2)}\n`);
    return path;
}

/**
 * The caller's Project that `reference` names: its id, or its name when
 * only one of the caller's Accounts has a Project of that name.
 */
export function resolveProject(projects: readonly Project[], reference: string): Result<Project, string> {
    const byId = projects.find((project) => project.id === reference);
    if (byId !== undefined) {
        return ok(byId);
    }
    const byName = projects.filter((project) => project.name === reference);
    if (byName.length === 1 && byName[0] !== undefined) {
        return ok(byName[0]);
    }
    if (byName.length > 1) {
        return err(`several of your Accounts have a Project ${reference}; use its id: ${byName.map((project) => project.id).join(', ')}`);
    }
    const names = projects.map((project) => project.name).join(', ');
    return err(`no Project ${reference} in your Accounts${names === '' ? '' : ` (you have ${names})`}`);
}

/**
 * The Project for this command: `--project` or `OUP_PROJECT` if given,
 * else the linked one. A linked Project that is gone is an error, not a
 * silent fallback to another.
 */
export async function projectFor(
    projects: readonly Project[],
    reference: string | undefined,
    cwd: string,
): Promise<Result<Project, string>> {
    if (reference !== undefined && reference !== '') {
        return resolveProject(projects, reference);
    }
    const found = await findLink(cwd);
    if (!found.ok) {
        return found;
    }
    if (found.value === undefined) {
        return err(`no Project linked here; run oup link <project>, or pass --project`);
    }
    const { path, link } = found.value;
    const project = projects.find((candidate) => candidate.id === link.projectId);
    return project === undefined ? err(`the Project ${link.project} linked in ${path} is not among yours any more`) : ok(project);
}
