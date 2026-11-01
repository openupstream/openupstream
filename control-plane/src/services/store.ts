/**
 * Services of one Project as the public API sees them, and every Service as
 * the Services operator gets it. Callers check first that the Project is
 * live and the caller's (projects/store.ts). The image's digest is resolved
 * by the caller before a row is written (registry.ts), so every row can be
 * deployed as it is.
 *
 * Deleting removes the row at once: a Service keeps no data, and the
 * Services operator removes its Deployment within one pass, as it does for
 * every object of its own no row asks for.
 */
import type { Service, ServiceRow, Site } from '@openupstream/sdk';
import type pg from 'pg';
import { ACCOUNT_HELD, FOREIGN_KEY_VIOLATION, UNIQUE_VIOLATION, unlessCodes } from '../db/errors.js';
import { parseImageReference, pinnedImage } from '../registry.js';
import { type Result, ok } from '../result.js';

interface Row {
    id: string;
    project_id: string;
    name: string;
    image: string;
    image_digest: string;
    deployed_at: Date;
    replicas: number;
    memory_mb: number;
    cpu_millicores: number;
    port: number;
    home_site: Site | null;
    has_registry_auth: boolean;
    created_at: Date;
}

/** The columns toService reads, of the table aliased `t` when given. */
const columns = (t = '') =>
    `${t}id, ${t}project_id, ${t}name, ${t}image, ${t}image_digest, ${t}deployed_at, ${t}replicas, ${t}memory_mb,
     ${t}cpu_millicores, ${t}port, ${t}home_site, ${t}registry_auth is not null as has_registry_auth, ${t}created_at`;
const COLUMNS = columns();

const toService = (row: Row): Service => ({
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    image: row.image,
    imageDigest: row.image_digest,
    deployedAt: row.deployed_at.toISOString(),
    replicas: row.replicas,
    memoryMb: row.memory_mb,
    cpuMillicores: row.cpu_millicores,
    port: row.port,
    homeSite: row.home_site,
    registryAuth: row.has_registry_auth,
    createdAt: row.created_at.toISOString(),
});

/** Where a Service's sealed registry credentials are bound (secrets/store.ts, sealProjectValue). */
export const registryAuthName = (serviceId: string): string => `service/${serviceId}/registry-auth`;

export async function listServices(pool: pg.Pool, projectId: string): Promise<Service[]> {
    const { rows } = await pool.query<Row>(`select ${COLUMNS} from services where project_id = $1 order by created_at, id`, [projectId]);
    return rows.map(toService);
}

export async function getService(pool: pg.Pool, projectId: string, id: string): Promise<Service | undefined> {
    const { rows } = await pool.query<Row>(`select ${COLUMNS} from services where id = $1 and project_id = $2`, [id, projectId]);
    return rows.map(toService)[0];
}

/** A Service's sealed registry credentials; undefined when it has none or does not exist. */
export async function sealedRegistryAuth(pool: pg.Pool, projectId: string, id: string): Promise<Buffer | undefined> {
    const { rows } = await pool.query<{ registry_auth: Buffer | null }>(
        'select registry_auth from services where id = $1 and project_id = $2',
        [id, projectId],
    );
    return rows[0]?.registry_auth ?? undefined;
}

/** A Service as it is written; `id` is chosen before, since its sealed credentials are bound to it. */
export interface ServiceRecord {
    readonly id: string;
    readonly name: string;
    readonly image: string;
    readonly imageDigest: string;
    readonly replicas: number;
    readonly memoryMb: number;
    readonly cpuMillicores: number;
    readonly port: number;
    readonly homeSite: Site | null;
    readonly registryAuth: Buffer | null;
}

export type CreateServiceError =
    | { readonly kind: 'name-taken'; readonly name: string }
    | { readonly kind: 'held' }
    | { readonly kind: 'project-deleted' };

export async function createService(
    pool: pg.Pool,
    projectId: string,
    record: ServiceRecord,
): Promise<Result<Service, CreateServiceError>> {
    const inserted = await unlessCodes<pg.QueryResult<Row>, CreateServiceError>(
        pool.query<Row>(
            `insert into services (id, project_id, name, image, image_digest, replicas, memory_mb, cpu_millicores, port, home_site, registry_auth)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning ${COLUMNS}`,
            [
                record.id,
                projectId,
                record.name,
                record.image,
                record.imageDigest,
                record.replicas,
                record.memoryMb,
                record.cpuMillicores,
                record.port,
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
    return inserted.ok ? ok(toService(inserted.value.rows[0] as Row)) : inserted;
}

/**
 * The columns a change writes; undefined leaves one as it is. A new digest
 * also moves `deployed_at`: the Service was deployed again, even when the
 * digest stayed the same.
 */
export interface ServiceChanges {
    readonly image?: string | undefined;
    readonly imageDigest?: string | undefined;
    readonly replicas?: number | undefined;
    readonly memoryMb?: number | undefined;
    readonly cpuMillicores?: number | undefined;
    readonly port?: number | undefined;
    readonly homeSite?: Site | null | undefined;
    readonly registryAuth?: Buffer | null | undefined;
}

const COLUMN_OF: Record<keyof ServiceChanges, string> = {
    image: 'image',
    imageDigest: 'image_digest',
    replicas: 'replicas',
    memoryMb: 'memory_mb',
    cpuMillicores: 'cpu_millicores',
    port: 'port',
    homeSite: 'home_site',
    registryAuth: 'registry_auth',
};

/** The changed Service; undefined when there is no such Service. */
export async function updateService(
    pool: pg.Pool,
    projectId: string,
    id: string,
    changes: ServiceChanges,
): Promise<Service | undefined> {
    const entries = (Object.keys(COLUMN_OF) as (keyof ServiceChanges)[]).filter((key) => changes[key] !== undefined);
    const assignments = [
        ...entries.map((key, i) => `${COLUMN_OF[key]} = $${i + 3}`),
        ...(changes.imageDigest === undefined ? [] : ['deployed_at = now()']),
    ];
    if (assignments.length === 0) {
        return getService(pool, projectId, id);
    }
    const { rows } = await pool.query<Row>(
        `update services set ${assignments.join(', ')} where id = $1 and project_id = $2 returning ${COLUMNS}`,
        [id, projectId, ...entries.map((key) => changes[key])],
    );
    return rows.map(toService)[0];
}

export type DeleteServiceOutcome = 'deleted' | 'not-found' | 'routed';

/** A Service that a Route still targets is not deleted. */
export async function deleteService(pool: pg.Pool, projectId: string, id: string): Promise<DeleteServiceOutcome> {
    const routed = await pool.query('select 1 from routes where service_id = $1', [id]);
    if ((routed.rowCount ?? 0) > 0) {
        return 'routed';
    }
    const deleted = await unlessCodes(pool.query('delete from services where id = $1 and project_id = $2', [id, projectId]), {
        // A Route created in between: the deferred foreign key refuses the delete.
        [FOREIGN_KEY_VIOLATION]: 'routed' as const,
    });
    if (!deleted.ok) {
        return deleted.error;
    }
    return deleted.value.rowCount === 1 ? 'deleted' : 'not-found';
}

interface OperatorRow extends Row {
    project_name: string;
    account_id: string;
    project_created_at: Date;
    site: Site;
    secrets_version: string;
}

/**
 * Every Service of a live Project (or of one Project), as the Services
 * operator needs it, and as the API compares it with the Deployment: the
 * pinned image, where a single replica runs, and the version of the
 * Project's Secrets that is in the cluster (secrets/render.ts).
 */
export async function listServiceRows(pool: pg.Pool, projectId?: string): Promise<ServiceRow[]> {
    const { rows } = await pool.query<OperatorRow>(
        `select ${columns('s.')},
                p.name as project_name, p.account_id, p.created_at as project_created_at,
                coalesce(
                    s.home_site,
                    (select d.home_site from databases d where d.project_id = s.project_id and d.deleted_at is null
                     order by d.created_at, d.id limit 1),
                    'hetzner-fsn1'
                ) as site,
                coalesce(p.secrets_version, '') as secrets_version
         from services s join projects p on p.id = s.project_id
         where p.deleted_at is null and ($1::uuid is null or s.project_id = $1)
         order by s.project_id, s.created_at, s.id`,
        [projectId ?? null],
    );
    return rows.flatMap((row) => {
        // Only an image that parsed was ever written; a row that does not is left out, not deployed wrongly.
        const image = parseImageReference(row.image);
        if (!image.ok) {
            return [];
        }
        const service = toService(row);
        return [
            {
                project: { id: row.project_id, accountId: row.account_id, name: row.project_name, createdAt: row.project_created_at.toISOString() },
                service: {
                    id: service.id,
                    name: service.name,
                    image: service.image,
                    imageDigest: service.imageDigest,
                    replicas: service.replicas,
                    memoryMb: service.memoryMb,
                    cpuMillicores: service.cpuMillicores,
                    port: service.port,
                },
                pinnedImage: pinnedImage(image.value, service.imageDigest),
                site: row.site,
                secretsVersion: row.secrets_version,
            },
        ];
    });
}
