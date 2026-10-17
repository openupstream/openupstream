/**
 * @openupstream/sdk
 *
 * Typed client for the openupstream control plane API. Used by the CLI and
 * the dashboard; published to npm for customers who want to automate their
 * own account.
 *
 * The API surface is defined here first and implemented in control-plane/.
 */

export const SDK_VERSION = '0.0.0';

export * from './model.js';
export * from './internal.js';
import type { DatabaseDetails, DatabaseInput, Id, Project, ProjectInput } from './model.js';

export interface ClientOptions {
    baseUrl?: string;
    /** A madAuth token: a Member's session or an API key. */
    token: string;
}

/** What went wrong, as the API said it: the HTTP status and its message. 0: the API was not reached. */
export interface ApiError {
    readonly status: number;
    readonly message: string;
}

export type ApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ApiError };

export class OpenUpstreamClient {
    readonly baseUrl: string;
    readonly #token: string;

    constructor(options: ClientOptions) {
        this.baseUrl = options.baseUrl ?? 'https://api.openupstream.com';
        this.#token = options.token;
    }

    async health(): Promise<{ ok: boolean }> {
        const res = await fetch(`${this.baseUrl}/v1/health`);
        return { ok: res.ok };
    }

    listProjects(): Promise<ApiResult<Project[]>> {
        return this.#call('GET', '/v1/projects');
    }

    createProject(input: ProjectInput): Promise<ApiResult<Project>> {
        return this.#call('POST', '/v1/projects', input);
    }

    getProject(projectId: Id): Promise<ApiResult<Project>> {
        return this.#call('GET', `/v1/projects/${encodeURIComponent(projectId)}`);
    }

    /** Deletes the Project and everything in it; backups are kept for the retention window. */
    deleteProject(projectId: Id): Promise<ApiResult<void>> {
        return this.#call('DELETE', `/v1/projects/${encodeURIComponent(projectId)}`);
    }

    listDatabases(projectId: Id): Promise<ApiResult<DatabaseDetails[]>> {
        return this.#call('GET', `/v1/projects/${encodeURIComponent(projectId)}/databases`);
    }

    createDatabase(projectId: Id, input: DatabaseInput): Promise<ApiResult<DatabaseDetails>> {
        return this.#call('POST', `/v1/projects/${encodeURIComponent(projectId)}/databases`, input);
    }

    getDatabase(projectId: Id, databaseId: Id): Promise<ApiResult<DatabaseDetails>> {
        return this.#call('GET', `/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}`);
    }

    /** Deletes the Database at once; its backups are kept for the retention window. */
    deleteDatabase(projectId: Id, databaseId: Id): Promise<ApiResult<void>> {
        return this.#call('DELETE', `/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}`);
    }

    async #call<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
        const response = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers: {
                authorization: `Bearer ${this.#token}`,
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error: { status: 0, message: error instanceof Error ? error.message : String(error) } }),
        );
        if (!response.ok) {
            return response;
        }
        // A proxy in front may answer with HTML; only the API's own answers are JSON.
        const isJson = response.value.headers.get('content-type')?.includes('application/json') ?? false;
        const parsed: unknown = isJson ? await response.value.json().catch(() => undefined) : undefined;
        if (response.value.ok) {
            return { ok: true, value: parsed as T };
        }
        const message =
            typeof parsed === 'object' && parsed !== null && 'error' in parsed && typeof parsed.error === 'string'
                ? parsed.error
                : response.value.statusText;
        return { ok: false, error: { status: response.value.status, message } };
    }
}
