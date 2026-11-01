/**
 * Jobs of one Project as the public API sees them, and every Job as the
 * Jobs operator gets it. Callers check first that the Project is live and
 * the caller's (projects/store.ts). As for Services, the image's digest is
 * resolved by the caller before a row is written (registry.ts).
 *
 * Deleting removes the row at once: the Jobs operator removes its CronJob
 * within one pass, and Kubernetes its runs with it, since they are the
 * CronJob's (decision 95).
 */
import type { Job, JobRow, Site } from '@openupstream/sdk';
import type pg from 'pg';
import { ACCOUNT_HELD, FOREIGN_KEY_VIOLATION, UNIQUE_VIOLATION, unlessCodes } from '../db/errors.js';
import { parseImageReference, pinnedImage } from '../registry.js';
import { type Result, ok } from '../result.js';
import { siteOf } from '../services/store.js';

interface Row {
    id: string;
    project_id: string;
    name: string;
    image: string;
    image_digest: string;
    deployed_at: Date;
    command: string[] | null;
    args: string[] | null;
    memory_mb: number;
    cpu_millicores: number;
    timeout_seconds: number;
    schedule: string | null;
    time_zone: string | null;
    home_site: Site | null;
    has_registry_auth: boolean;
    created_at: Date;
}

/** The columns toJob reads, of the table aliased `t` when given. */
const columns = (t = '') =>
    `${t}id, ${t}project_id, ${t}name, ${t}image, ${t}image_digest, ${t}deployed_at, ${t}command, ${t}args, ${t}memory_mb,
     ${t}cpu_millicores, ${t}timeout_seconds, ${t}schedule, ${t}time_zone, ${t}home_site,
     ${t}registry_auth is not null as has_registry_auth, ${t}created_at`;
const COLUMNS = columns();

const toJob = (row: Row): Job => ({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    image: row.image,
    imageDigest: row.image_digest,
    deployedAt: row.deployed_at.toISOString(),
    command: row.command,
    args: row.args,
    memoryMb: row.memory_mb,
    cpuMillicores: row.cpu_millicores,
    timeoutSeconds: row.timeout_seconds,
    schedule: row.schedule,
    timeZone: row.time_zone,
    homeSite: row.home_site,
    registryAuth: row.has_registry_auth,
    createdAt: row.created_at.toISOString(),
});

/** Where a Job's sealed registry credentials are bound (secrets/store.ts, sealProjectValue). */
export const jobRegistryAuthName = (jobId: string): string => `job/${jobId}/registry-auth`;

/** node-postgres sends arrays as Postgres arrays; jsonb wants their JSON. */
const asJson = (value: readonly string[] | null): string | null => (value === null ? null : JSON.stringify(value));

export async function listJobs(pool: pg.Pool, projectId: string): Promise<Job[]> {
    const { rows } = await pool.query<Row>(`select ${COLUMNS} from jobs where project_id = $1 order by created_at, id`, [projectId]);
    return rows.map(toJob);
}

export async function getJob(pool: pg.Pool, projectId: string, id: string): Promise<Job | undefined> {
    const { rows } = await pool.query<Row>(`select ${COLUMNS} from jobs where id = $1 and project_id = $2`, [id, projectId]);
    return rows.map(toJob)[0];
}

/** A Job's sealed registry credentials; undefined when it has none or does not exist. */
export async function sealedJobRegistryAuth(pool: pg.Pool, projectId: string, id: string): Promise<Buffer | undefined> {
    const { rows } = await pool.query<{ registry_auth: Buffer | null }>(
        'select registry_auth from jobs where id = $1 and project_id = $2',
        [id, projectId],
    );
    return rows[0]?.registry_auth ?? undefined;
}

/** A Job as it is written; `id` is chosen before, since its sealed credentials are bound to it. */
export interface JobRecord {
    readonly id: string;
    readonly name: string;
    readonly image: string;
    readonly imageDigest: string;
    readonly command: readonly string[] | null;
    readonly args: readonly string[] | null;
    readonly memoryMb: number;
    readonly cpuMillicores: number;
    readonly timeoutSeconds: number;
    readonly schedule: string | null;
    readonly timeZone: string | null;
    readonly homeSite: Site | null;
    readonly registryAuth: Buffer | null;
}

export type CreateJobError =
    | { readonly kind: 'name-taken'; readonly name: string }
    | { readonly kind: 'held' }
    | { readonly kind: 'project-deleted' };

export async function createJob(pool: pg.Pool, projectId: string, record: JobRecord): Promise<Result<Job, CreateJobError>> {
    const inserted = await unlessCodes<pg.QueryResult<Row>, CreateJobError>(
        pool.query<Row>(
            `insert into jobs (id, project_id, name, image, image_digest, command, args, memory_mb, cpu_millicores,
                               timeout_seconds, schedule, time_zone, home_site, registry_auth)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning ${COLUMNS}`,
            [
                record.id,
                projectId,
                record.name,
                record.image,
                record.imageDigest,
                asJson(record.command),
                asJson(record.args),
                record.memoryMb,
                record.cpuMillicores,
                record.timeoutSeconds,
                record.schedule,
                record.timeZone,
                record.homeSite,
                record.registryAuth,
            ],
        ),
        {
            [UNIQUE_VIOLATION]: { kind: 'name-taken', name: record.name },
            [ACCOUNT_HELD]: { kind: 'held' },
            [FOREIGN_KEY_VIOLATION]: { kind: 'project-deleted' },
        },
    );
    return inserted.ok ? ok(toJob(inserted.value.rows[0] as Row)) : inserted;
}

/**
 * The columns a change writes; undefined leaves one as it is. A new digest
 * also moves `deployed_at`, as for a Service.
 */
export interface JobChanges {
    readonly image?: string | undefined;
    readonly imageDigest?: string | undefined;
    readonly command?: readonly string[] | null | undefined;
    readonly args?: readonly string[] | null | undefined;
    readonly memoryMb?: number | undefined;
    readonly cpuMillicores?: number | undefined;
    readonly timeoutSeconds?: number | undefined;
    readonly schedule?: string | null | undefined;
    readonly timeZone?: string | null | undefined;
    readonly homeSite?: Site | null | undefined;
    readonly registryAuth?: Buffer | null | undefined;
}

const COLUMN_OF: Record<keyof JobChanges, string> = {
    image: 'image',
    imageDigest: 'image_digest',
    command: 'command',
    args: 'args',
    memoryMb: 'memory_mb',
    cpuMillicores: 'cpu_millicores',
    timeoutSeconds: 'timeout_seconds',
    schedule: 'schedule',
    timeZone: 'time_zone',
    homeSite: 'home_site',
    registryAuth: 'registry_auth',
};

const valueOf = (changes: JobChanges, key: keyof JobChanges): unknown => {
    const value = changes[key];
    return key === 'command' || key === 'args' ? asJson(value as readonly string[] | null) : value;
};

/** The changed Job; undefined when there is no such Job. */
export async function updateJob(pool: pg.Pool, projectId: string, id: string, changes: JobChanges): Promise<Job | undefined> {
    const entries = (Object.keys(COLUMN_OF) as (keyof JobChanges)[]).filter((key) => changes[key] !== undefined);
    const assignments = [
        ...entries.map((key, i) => `${COLUMN_OF[key]} = $${i + 3}`),
        ...(changes.imageDigest === undefined ? [] : ['deployed_at = now()']),
    ];
    if (assignments.length === 0) {
        return getJob(pool, projectId, id);
    }
    const { rows } = await pool.query<Row>(
        `update jobs set ${assignments.join(', ')} where id = $1 and project_id = $2 returning ${COLUMNS}`,
        [id, projectId, ...entries.map((key) => valueOf(changes, key))],
    );
    return rows.map(toJob)[0];
}

/** Whether there was such a Job. */
export async function deleteJob(pool: pg.Pool, projectId: string, id: string): Promise<boolean> {
    const deleted = await pool.query('delete from jobs where id = $1 and project_id = $2', [id, projectId]);
    return deleted.rowCount === 1;
}

interface OperatorRow extends Row {
    project_name: string;
    account_id: string;
    project_created_at: Date;
    site: Site;
    secrets_version: string;
}

/**
 * Every Job of a live Project (or of one Project), as the Jobs operator
 * needs it, and as the API compares it with the CronJob: the pinned image,
 * where its runs go (as for a single-replica Service), and the version of
 * the Project's Secrets that is in the cluster (secrets/render.ts).
 */
export async function listJobRows(pool: pg.Pool, projectId?: string): Promise<JobRow[]> {
    const { rows } = await pool.query<OperatorRow>(
        `select ${columns('j.')},
                p.name as project_name, p.account_id, p.created_at as project_created_at,
                ${siteOf('j')} as site,
                coalesce(p.secrets_version, '') as secrets_version
         from jobs j join projects p on p.id = j.project_id
         where p.deleted_at is null and ($1::uuid is null or j.project_id = $1)
         order by j.project_id, j.created_at, j.id`,
        [projectId ?? null],
    );
    return rows.flatMap((row) => {
        // Only an image that parsed was ever written; a row that does not is left out, not deployed wrongly.
        const image = parseImageReference(row.image);
        if (!image.ok) {
            return [];
        }
        const job = toJob(row);
        return [
            {
                project: { id: row.project_id, accountId: row.account_id, name: row.project_name, createdAt: row.project_created_at.toISOString() },
                job: {
                    id: job.id,
                    name: job.name,
                    image: job.image,
                    imageDigest: job.imageDigest,
                    command: job.command,
                    args: job.args,
                    memoryMb: job.memoryMb,
                    cpuMillicores: job.cpuMillicores,
                    timeoutSeconds: job.timeoutSeconds,
                    schedule: job.schedule,
                    timeZone: job.timeZone,
                },
                pinnedImage: pinnedImage(image.value, job.imageDigest),
                site: row.site,
                secretsVersion: row.secrets_version,
            },
        ];
    });
}
