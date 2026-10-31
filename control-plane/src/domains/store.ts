/**
 * Domains of one Project (ARCHITECTURE.md, "Routing and domains"). Every
 * Project has its default Domain, `<project>-<random>.<customer domain>`,
 * created with the Project and kept when it is renamed (decision 71).
 * Custom domains are claimed with a token, and verified once the token is
 * published as a TXT record (decisions 14 and 85).
 */
import { randomBytes, randomInt } from 'node:crypto';
import { type Domain, type TxtRecord, txtRecordName } from '@openupstream/sdk';
import type pg from 'pg';
import { unlessUnique } from '../db/errors.js';
import { inTransaction } from '../db/transaction.js';
import type { ObjectStorage } from '../garage.js';
import { type Result, err, ok } from '../result.js';
import { unserveIfUnrouted } from '../routes/store.js';
import type { TxtLookup } from './dns.js';

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
                      ? { state: 'pending', txtRecord: { name: txtRecordName(row.hostname), value: row.verification_token ?? '' } }
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

/** Whether `hostname` is one of `domains` or below one: the platform's own names, which no Account may claim. */
export const isReserved = (hostname: string, domains: readonly string[]): boolean =>
    domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));

export type CreateDomainError = { readonly kind: 'claimed' } | { readonly kind: 'in-use' };

/**
 * Claims `hostname` for the Project, pending until its TXT record is
 * verified: `claimed` if the Project has it already, `in-use` if another
 * Project has verified it. Other pending claims do not stand in the way.
 */
export async function createCustomDomain(pool: pg.Pool, projectId: string, hostname: string): Promise<Result<Domain, CreateDomainError>> {
    // 24 random bytes, 32 characters: the schema wants at least 32.
    const token = randomBytes(24).toString('base64url');
    const inserted = await unlessUnique(
        pool.query<DomainRow>(
            `insert into domains (project_id, hostname, kind, verification_token)
             select $1, $2, 'custom', $3
             where not exists (select 1 from domains where hostname = $2 and verified_at is not null and project_id <> $1)
             returning ${COLUMNS}`,
            [projectId, hostname, token],
        ),
        { kind: 'claimed' } as const,
    );
    if (!inserted.ok) {
        return inserted;
    }
    const row = inserted.value.rows[0];
    return row === undefined ? err({ kind: 'in-use' }) : ok(toDomain(row));
}

export type VerifyDomainError =
    | { readonly kind: 'not-found' }
    | { readonly kind: 'not-published'; readonly txtRecord: TxtRecord; readonly found: readonly string[] }
    | { readonly kind: 'in-use' }
    | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * Looks up the Domain's TXT record now and, when it holds the token, marks
 * the Domain verified, so its Routes are served from the next operator
 * pass. The first claim to be verified gets the hostname (`in-use` for the
 * others). A verified Domain stays verified: the record is not checked
 * again (decision 85).
 */
export async function verifyDomain(
    pool: pg.Pool,
    lookup: TxtLookup,
    projectId: string,
    id: string,
): Promise<Result<Domain, VerifyDomainError>> {
    const { rows } = await pool.query<DomainRow>(`select ${COLUMNS} from domains where id = $1 and project_id = $2`, [id, projectId]);
    const row = rows[0];
    if (row === undefined) {
        return err({ kind: 'not-found' });
    }
    if (row.verified_at !== null) {
        return ok(toDomain(row));
    }
    const txtRecord = { name: txtRecordName(row.hostname), value: row.verification_token ?? '' };
    const found = await lookup(txtRecord.name);
    if (!found.ok) {
        return err({ kind: 'unavailable', reason: found.error });
    }
    if (!found.value.includes(txtRecord.value)) {
        return err({ kind: 'not-published', txtRecord, found: found.value });
    }
    const updated = await unlessUnique(
        pool.query<DomainRow>(`update domains set verified_at = now() where id = $1 and verified_at is null returning ${COLUMNS}`, [id]),
        { kind: 'in-use' } as const,
    );
    if (!updated.ok) {
        return updated;
    }
    const verified = updated.value.rows[0];
    if (verified !== undefined) {
        return ok(toDomain(verified));
    }
    // Verified by a concurrent request meanwhile, or deleted.
    const current = await getDomain(pool, projectId, id);
    return current === undefined ? err({ kind: 'not-found' }) : ok(current);
}

export type DeleteDomainError = { readonly kind: 'not-found' } | { readonly kind: 'default' };

/**
 * Deletes a custom domain with its Routes; a Bucket left without Routes
 * stops being a website in Garage. Answers Garage's errors for those, which
 * do not stop the deletion. The default Domain stays as long as its
 * Project.
 */
export async function deleteDomain(
    pool: pg.Pool,
    storage: ObjectStorage,
    projectId: string,
    id: string,
): Promise<Result<{ readonly websiteErrors: readonly string[] }, DeleteDomainError>> {
    return inTransaction(
        pool,
        async (client): Promise<Result<{ readonly websiteErrors: readonly string[] }, DeleteDomainError>> => {
            const domain = await client.query<{ kind: DomainRow['kind'] }>('select kind from domains where id = $1 and project_id = $2 for update', [
                id,
                projectId,
            ]);
            const kind = domain.rows[0]?.kind;
            if (kind === undefined) {
                return err({ kind: 'not-found' });
            }
            if (kind === 'default') {
                return err({ kind: 'default' });
            }
            const routes = await client.query<{ bucket_id: string | null }>('delete from routes where domain_id = $1 returning bucket_id', [id]);
            await client.query('delete from domains where id = $1', [id]);
            // One at a time and in a fixed order, so two deletions never wait for each other's locks.
            const bucketIds = [...new Set(routes.rows.flatMap((route) => (route.bucket_id === null ? [] : [route.bucket_id])))].sort();
            const websiteErrors: string[] = [];
            for (const bucketId of bucketIds) {
                const error = await unserveIfUnrouted(client, storage, bucketId);
                if (error !== undefined) {
                    websiteErrors.push(error);
                }
            }
            return ok({ websiteErrors });
        },
        (result) => result.ok,
    );
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
