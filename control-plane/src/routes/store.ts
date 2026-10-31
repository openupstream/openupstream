/**
 * The routing table (ARCHITECTURE.md, "Routing and domains"): Routes under a
 * Domain, each sending a path prefix to a Bucket of the same Project. The
 * Routes operator turns them into Traefik objects (operators/src/routes);
 * the Bucket's website settings in Garage are set here, while the request
 * waits, since only the control plane holds Garage's admin token.
 *
 * Services as Route targets come with Services.
 */
import type { DomainRouting, Route, RouteInput } from '@openupstream/sdk';
import pg from 'pg';
import { UNIQUE_VIOLATION } from '../db/errors.js';
import type { ObjectStorage } from '../garage.js';
import { inTransaction } from '../db/transaction.js';
import { type Result, err, ok } from '../result.js';

interface RouteRow {
    id: string;
    domain_id: string;
    path_prefix: string;
    bucket_id: string | null;
    service_id: string | null;
    spa_fallback: boolean;
    created_at: Date;
}

const toRoute = (row: RouteRow): Route => ({
    id: row.id,
    domainId: row.domain_id,
    pathPrefix: row.path_prefix,
    target:
        row.bucket_id !== null
            ? { kind: 'bucket', bucketId: row.bucket_id, spaFallback: row.spa_fallback }
            : { kind: 'service', serviceId: row.service_id ?? '' },
    createdAt: row.created_at.toISOString(),
});

const COLUMNS = 'id, domain_id, path_prefix, bucket_id, service_id, spa_fallback, created_at';

/** The Domain's Routes, longest prefix first, as Traefik matches them. */
export async function listRoutes(pool: pg.Pool, domainId: string): Promise<Route[]> {
    const { rows } = await pool.query<RouteRow>(
        `select ${COLUMNS} from routes where domain_id = $1 order by length(path_prefix) desc, path_prefix`,
        [domainId],
    );
    return rows.map(toRoute);
}

export type CreateRouteError =
    | { readonly kind: 'bucket-not-found' }
    | { readonly kind: 'prefix-taken'; readonly pathPrefix: string }
    | { readonly kind: 'spa-conflict'; readonly spaFallback: boolean }
    | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * Inserts the Route and sets the Bucket's website settings in Garage in one
 * transaction: if Garage cannot be reached, there is no Route. The Bucket's
 * row stays locked meanwhile, so it cannot be deleted under the new Route.
 * `projectId` and `domainId` are the caller's, already checked; `input` is
 * validated by the API, and the schema checks the prefix again.
 */
export async function createRoute(
    pool: pg.Pool,
    storage: ObjectStorage,
    projectId: string,
    domainId: string,
    input: RouteInput,
): Promise<Result<Route, CreateRouteError>> {
    const spaFallback = input.spaFallback ?? false;
    return inTransaction(pool, async (client): Promise<Result<Route, CreateRouteError>> => {
        const bucket = await client.query<{ garage_bucket_id: string; spa_fallback: boolean | null }>(
            `select b.garage_bucket_id, (select r.spa_fallback from routes r where r.bucket_id = b.id limit 1) as spa_fallback
             from buckets b where b.id = $1 and b.project_id = $2 and b.deleted_at is null for share of b`,
            [input.bucketId, projectId],
        );
        const found = bucket.rows[0];
        if (found === undefined) {
            return err({ kind: 'bucket-not-found' });
        }
        if (found.spa_fallback !== null && found.spa_fallback !== spaFallback) {
            return err({ kind: 'spa-conflict', spaFallback: found.spa_fallback });
        }
        const inserted = await client
            .query<RouteRow>(
                `insert into routes (project_id, domain_id, path_prefix, bucket_id, spa_fallback)
                 values ($1, $2, $3, $4, $5) returning ${COLUMNS}`,
                [projectId, domainId, input.pathPrefix, input.bucketId, spaFallback],
            )
            .then(
                (result) => ok(result),
                (error: unknown) =>
                    error instanceof pg.DatabaseError && error.code === UNIQUE_VIOLATION
                        ? err({ kind: 'prefix-taken', pathPrefix: input.pathPrefix } as const)
                        : Promise.reject(error),
            );
        if (!inserted.ok) {
            return inserted;
        }
        const website = await storage.setWebsite(found.garage_bucket_id, { spaFallback });
        if (!website.ok) {
            return err({ kind: 'unavailable', reason: website.error });
        }
        // An insert … returning always returns its row.
        return ok(toRoute(inserted.value.rows[0] as RouteRow));
    }, (result) => result.ok);
}

export type DeleteRouteOutcome =
    | { readonly kind: 'not-found' }
    | { readonly kind: 'deleted'; readonly websiteError?: string };

/**
 * Deletes the Route. When it was the Bucket's last one, the Bucket stops
 * being served by Garage's website endpoint too, while the Bucket's row is
 * locked, so a Route created for it meanwhile waits and sets the website
 * again afterwards. If Garage cannot be reached for that, the Route is gone
 * all the same, since nothing routes to the website endpoint without one.
 */
export async function deleteRoute(
    pool: pg.Pool,
    storage: ObjectStorage,
    domainId: string,
    id: string,
): Promise<DeleteRouteOutcome> {
    return inTransaction(
        pool,
        async (client): Promise<DeleteRouteOutcome> => {
            const route = await client.query<{ bucket_id: string | null }>(
                'delete from routes where id = $1 and domain_id = $2 returning bucket_id',
                [id, domainId],
            );
            const bucketId = route.rows[0]?.bucket_id;
            if (route.rowCount !== 1) {
                return { kind: 'not-found' };
            }
            if (bucketId === null || bucketId === undefined) {
                return { kind: 'deleted' };
            }
            // A separate statement after the lock, so it sees Routes committed while it waited.
            const bucket = await client.query<{ garage_bucket_id: string }>(
                'select garage_bucket_id from buckets where id = $1 for update',
                [bucketId],
            );
            const routed = await client.query('select 1 from routes where bucket_id = $1 limit 1', [bucketId]);
            const garageBucketId = bucket.rows[0]?.garage_bucket_id;
            if (garageBucketId === undefined || routed.rowCount !== 0) {
                return { kind: 'deleted' };
            }
            const website = await storage.setWebsite(garageBucketId, undefined);
            return website.ok ? { kind: 'deleted' } : { kind: 'deleted', websiteError: website.error };
        },
        (outcome) => outcome.kind === 'deleted',
    );
}

/** Every Domain that has Routes to live Buckets, for the Routes operator; a stable order. */
export async function listDomainRoutings(pool: pg.Pool): Promise<DomainRouting[]> {
    const { rows } = await pool.query<{
        project_id: string;
        project_name: string;
        domain_id: string;
        hostname: string;
        route_id: string;
        path_prefix: string;
        bucket_name: string;
        spa_fallback: boolean;
    }>(`
        select d.project_id, p.name as project_name, d.id as domain_id, d.hostname, r.id as route_id, r.path_prefix, b.name as bucket_name, r.spa_fallback
        from routes r
        join domains d on d.id = r.domain_id
        join buckets b on b.id = r.bucket_id and b.deleted_at is null
        join projects p on p.id = d.project_id and p.deleted_at is null
        where d.verified_at is not null
        order by d.created_at, d.id, length(r.path_prefix) desc, r.path_prefix`);
    const byDomain = new Map<string, DomainRouting>();
    for (const row of rows) {
        const route = { id: row.route_id, pathPrefix: row.path_prefix, bucketName: row.bucket_name, spaFallback: row.spa_fallback };
        const domain = byDomain.get(row.domain_id);
        byDomain.set(
            row.domain_id,
            domain === undefined
                ? { projectId: row.project_id, projectName: row.project_name, domainId: row.domain_id, hostname: row.hostname, routes: [route] }
                : { ...domain, routes: [...domain.routes, route] },
        );
    }
    return [...byDomain.values()];
}
