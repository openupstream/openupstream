/**
 * The operators' side of the control plane's internal API: the Database
 * rows, fetched with the operator's ServiceAccount token.
 */
import { type DatabaseRow, INTERNAL_DATABASES_PATH } from '@openupstream/sdk';
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

/**
 * `token` is read on every call: projected ServiceAccount tokens are
 * rotated by the kubelet.
 */
export function controlPlaneRows(baseUrl: string, token: () => Promise<string>): FetchRows {
    return async () => {
        const response = await token()
            .then((bearer) =>
                fetch(new URL(INTERNAL_DATABASES_PATH, baseUrl), {
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
            return err({ kind: 'status', status: response.value.status, body: (await response.value.text()).slice(0, 500) });
        }
        const body: unknown = await response.value.json().then(
            (value: unknown) => value,
            () => undefined,
        );
        return parseRows(body);
    };
}
