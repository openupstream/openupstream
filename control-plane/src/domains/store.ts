/**
 * Domains of one Project (ARCHITECTURE.md, "Routing and domains"). Every
 * Project has its default Domain, `<project>-<random>.<customer domain>`,
 * created with the Project and kept when it is renamed (decision 71).
 * Custom domains, with their TXT proof, come later; the schema already
 * holds them.
 */
import { randomInt } from 'node:crypto';
import type { Domain } from '@openupstream/sdk';
import type pg from 'pg';

/** Long enough that two Projects never draw the same hostname (36^8). */
const SUFFIX_LENGTH = 8;
const SUFFIX_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export const randomSuffix = (): string =>
    Array.from({ length: SUFFIX_LENGTH }, () => SUFFIX_ALPHABET[randomInt(SUFFIX_ALPHABET.length)]).join('');

/**
 * The default hostname for a Project name, cut so the label stays within 63
 * characters, and never ending in a hyphen before the suffix.
 */
export const defaultHostname = (projectName: string, customerDomain: string, suffix: string = randomSuffix()): string =>
    `${projectName.slice(0, 63 - SUFFIX_LENGTH - 1).replace(/-+$/, '')}-${suffix}.${customerDomain}`;

interface DomainRow {
    id: string;
    project_id: string;
    hostname: string;
    kind: 'default' | 'custom';
    verification_token: string | null;
    verified_at: Date | null;
    created_at: Date;
}

const toDomain = (row: DomainRow): Domain =>
    row.kind === 'default'
        ? { id: row.id, projectId: row.project_id, hostname: row.hostname, kind: 'default', createdAt: row.created_at.toISOString() }
        : {
              id: row.id,
              projectId: row.project_id,
              hostname: row.hostname,
              kind: 'custom',
              createdAt: row.created_at.toISOString(),
              verification:
                  row.verified_at === null
                      ? { state: 'pending', txtRecord: { name: `_openupstream.${row.hostname}`, value: row.verification_token ?? '' } }
                      : { state: 'verified', verifiedAt: row.verified_at.toISOString() },
          };

const COLUMNS = 'id, project_id, hostname, kind, verification_token, verified_at, created_at';

/** The default Domain first, then the others by age. */
export async function listDomains(pool: pg.Pool, projectId: string): Promise<Domain[]> {
    const { rows } = await pool.query<DomainRow>(
        `select ${COLUMNS} from domains where project_id = $1 order by kind = 'default' desc, created_at, id`,
        [projectId],
    );
    return rows.map(toDomain);
}

export async function getDomain(pool: pg.Pool, projectId: string, id: string): Promise<Domain | undefined> {
    const { rows } = await pool.query<DomainRow>(`select ${COLUMNS} from domains where id = $1 and project_id = $2`, [id, projectId]);
    return rows.map(toDomain)[0];
}

/**
 * Gives every live Project without one its default Domain: Projects created
 * before default Domains existed. Run at startup; a Project that gets one
 * meanwhile is skipped.
 */
export async function ensureDefaultDomains(pool: pg.Pool, customerDomain: string): Promise<number> {
    const { rows } = await pool.query<{ id: string; name: string }>(
        `select id, name from projects p where deleted_at is null
         and not exists (select 1 from domains d where d.project_id = p.id and d.kind = 'default')`,
    );
    for (const project of rows) {
        await pool.query(
            `insert into domains (project_id, hostname, kind, verified_at) values ($1, $2, 'default', now())
             on conflict do nothing`,
            [project.id, defaultHostname(project.name, customerDomain)],
        );
    }
    return rows.length;
}
