/**
 * The operators' side of the control plane's internal API: the Database
 * rows and the routing table, fetched with the operator's ServiceAccount
 * token.
 */
import {
    type DatabaseRow,
    type DomainRouting,
    INTERNAL_DATABASES_PATH,
    INTERNAL_ROUTES_PATH,
    INTERNAL_SERVICES_PATH,
    type ServiceRow,
} from '@openupstream/sdk';
import { type Result, err, ok } from './result.js';

export type FetchRowsError =
    | { readonly kind: 'unreachable'; readonly message: string }
    | { readonly kind: 'status'; readonly status: number; readonly body: string }
    | { readonly kind: 'malformed'; readonly message: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** fetch reports only "fetch failed"; the reason (ECONNREFUSED, ENOTFOUND, …) is its cause. */
const describe = (error: unknown): string =>
    error instanceof Error
        ? error.cause instanceof Error
            ? `${error.message}: ${error.cause.message}`
            : error.message
        : String(error);

/**
 * Only the shape: each entry has a project and a database object with ids.
 * Whether a row can run is databaseManifests' to decide, per row.
 */
const isRow = (value: unknown): value is DatabaseRow =>
    isObject(value) &&
    isObject(value['project']) &&
    isObject(value['database']) &&
    typeof value['project']['id'] === 'string' &&
    typeof value['database']['id'] === 'string';

export const parseRows = (body: unknown): Result<DatabaseRow[], FetchRowsError> =>
    Array.isArray(body) && body.every(isRow)
        ? ok(body)
        : err({ kind: 'malformed', message: 'expected an array of { project, database }' });

export type FetchRows = () => Promise<Result<DatabaseRow[], FetchRowsError>>;

/** Only the shape the Routes operator relies on; the control plane checked the values when it stored them. */
const isRouting = (value: unknown): value is DomainRouting =>
    isObject(value) &&
    typeof value['projectId'] === 'string' &&
    typeof value['projectName'] === 'string' &&
    typeof value['domainId'] === 'string' &&
    typeof value['hostname'] === 'string' &&
    (value['kind'] === 'default' || value['kind'] === 'custom') &&
    Array.isArray(value['routes']) &&
    value['routes'].every(
        (route: unknown) =>
            isObject(route) &&
            typeof route['id'] === 'string' &&
            typeof route['pathPrefix'] === 'string' &&
            ((route['kind'] === 'bucket' && typeof route['bucketName'] === 'string' && typeof route['spaFallback'] === 'boolean') ||
                (route['kind'] === 'service' && typeof route['serviceId'] === 'string' && typeof route['port'] === 'number')),
    );

export const parseRoutings = (body: unknown): Result<DomainRouting[], FetchRowsError> =>
    Array.isArray(body) && body.every(isRouting)
        ? ok(body)
        : err({ kind: 'malformed', message: 'expected an array of { projectId, projectName, domainId, hostname, kind, routes }' });

export type FetchRoutings = () => Promise<Result<DomainRouting[], FetchRowsError>>;

/** Only the shape the Services operator relies on; the control plane checked the values when it stored them. */
const isServiceRow = (value: unknown): value is ServiceRow =>
    isObject(value) &&
    isObject(value['project']) &&
    typeof value['project']['id'] === 'string' &&
    typeof value['project']['name'] === 'string' &&
    isObject(value['service']) &&
    typeof value['service']['id'] === 'string' &&
    typeof value['service']['name'] === 'string' &&
    typeof value['service']['replicas'] === 'number' &&
    typeof value['service']['memoryMb'] === 'number' &&
    typeof value['service']['cpuMillicores'] === 'number' &&
    typeof value['service']['port'] === 'number' &&
    typeof value['pinnedImage'] === 'string' &&
    /@sha256:[0-9a-f]{64}$/.test(value['pinnedImage']) &&
    (value['site'] === 'hetzner-fsn1' || value['site'] === 'ovh-lim') &&
    typeof value['secretsVersion'] === 'string';

export const parseServiceRows = (body: unknown): Result<ServiceRow[], FetchRowsError> =>
    Array.isArray(body) && body.every(isServiceRow)
        ? ok(body)
        : err({ kind: 'malformed', message: 'expected an array of { project, service, pinnedImage, site, secretsVersion }' });

export type FetchServices = () => Promise<Result<ServiceRow[], FetchRowsError>>;

/**
 * `token` is read on every call: projected ServiceAccount tokens are
 * rotated by the kubelet.
 */
export function controlPlaneRows(baseUrl: string, token: () => Promise<string>): FetchRows {
    return fetchInternal(baseUrl, INTERNAL_DATABASES_PATH, token, parseRows);
}

export function controlPlaneRoutings(baseUrl: string, token: () => Promise<string>): FetchRoutings {
    return fetchInternal(baseUrl, INTERNAL_ROUTES_PATH, token, parseRoutings);
}

export function controlPlaneServices(baseUrl: string, token: () => Promise<string>): FetchServices {
    return fetchInternal(baseUrl, INTERNAL_SERVICES_PATH, token, parseServiceRows);
}

function fetchInternal<T>(
    baseUrl: string,
    path: string,
    token: () => Promise<string>,
    parse: (body: unknown) => Result<T, FetchRowsError>,
): () => Promise<Result<T, FetchRowsError>> {
    return async () => {
        const response = await token()
            .then((bearer) =>
                fetch(new URL(path, baseUrl), {
                    headers: { authorization: `Bearer ${bearer.trim()}` },
                    signal: AbortSignal.timeout(10_000),
                }),
            )
            .then(
                (value) => ok(value),
                (error: unknown) => err({ kind: 'unreachable', message: describe(error) } as const),
            );
        if (!response.ok) {
            return response;
        }
        if (response.value.status !== 200) {
            const body = await response.value.text().then(
                (text) => text.slice(0, 500),
                () => '',
            );
            return err({ kind: 'status', status: response.value.status, body });
        }
        const body: unknown = await response.value.json().then(
            (value: unknown) => value,
            () => undefined,
        );
        return parse(body);
    };
}
