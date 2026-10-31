/**
 * @openupstream/sdk
 *
 * Typed client for the openupstream control plane API. Used by the CLI and
 * the dashboard; published to npm for customers who want to automate their
 * own account.
 *
 * The API surface is defined here first and implemented in control-plane/.
 */

export const SDK_VERSION = '0.1.1';

export * from './model.js';
export * from './internal.js';
import type {
    Account,
    AccountInput,
    Bucket,
    BucketDetails,
    BucketInput,
    CliLogin,
    CustomDomainInput,
    DatabaseDetails,
    DatabaseInput,
    Domain,
    Id,
    Project,
    ProjectInput,
    Route,
    RouteInput,
} from './model.js';

export const DEFAULT_API_URL = 'https://api.openupstream.com';

export interface ClientOptions {
    baseUrl?: string;
    /** A madAuth session token, an access token of `oup`, or one of the user's madAuth API keys (`madauth_…`). */
    token: string;
}

/** Where the CLI signs in; asked before there is a token. 404 when the platform has no CLI client. */
export async function cliLogin(baseUrl: string = DEFAULT_API_URL): Promise<ApiResult<CliLogin>> {
    return new OpenUpstreamClient({ baseUrl, token: '' }).cliLogin();
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
        this.baseUrl = options.baseUrl ?? DEFAULT_API_URL;
        this.#token = options.token;
    }

    async health(): Promise<{ ok: boolean }> {
        const res = await fetch(`${this.baseUrl}/v1/health`);
        return { ok: res.ok };
    }

    cliLogin(): Promise<ApiResult<CliLogin>> {
        return this.#call('GET', '/v1/login');
    }

    /** The Accounts the caller is a Member of. */
    listAccounts(): Promise<ApiResult<Account[]>> {
        return this.#call('GET', '/v1/accounts');
    }

    /** A new Account, with the caller as its first Member. */
    createAccount(input: AccountInput): Promise<ApiResult<Account>> {
        return this.#call('POST', '/v1/accounts', input);
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

    listBuckets(projectId: Id): Promise<ApiResult<Bucket[]>> {
        return this.#call('GET', `/v1/projects/${encodeURIComponent(projectId)}/buckets`);
    }

    /** A new Bucket with its own key; usable as soon as this returns. */
    createBucket(projectId: Id, input: BucketInput): Promise<ApiResult<BucketDetails>> {
        return this.#call('POST', `/v1/projects/${encodeURIComponent(projectId)}/buckets`, input);
    }

    getBucket(projectId: Id, bucketId: Id): Promise<ApiResult<BucketDetails>> {
        return this.#call('GET', `/v1/projects/${encodeURIComponent(projectId)}/buckets/${encodeURIComponent(bucketId)}`);
    }

    /** Deletes the Bucket and every object in it; there is no retention window. */
    deleteBucket(projectId: Id, bucketId: Id): Promise<ApiResult<void>> {
        return this.#call('DELETE', `/v1/projects/${encodeURIComponent(projectId)}/buckets/${encodeURIComponent(bucketId)}`);
    }

    /** The Project's Domains; every Project has its default Domain. */
    listDomains(projectId: Id): Promise<ApiResult<Domain[]>> {
        return this.#call('GET', `/v1/projects/${encodeURIComponent(projectId)}/domains`);
    }

    /** Claims a custom domain; publish its TXT record, then call verifyDomain. */
    createDomain(projectId: Id, input: CustomDomainInput): Promise<ApiResult<Domain>> {
        return this.#call('POST', `/v1/projects/${encodeURIComponent(projectId)}/domains`, input);
    }

    /** Looks up the custom domain's TXT record now; once found, the Domain is verified and its Routes are served. */
    verifyDomain(projectId: Id, domainId: Id): Promise<ApiResult<Domain>> {
        return this.#call('POST', `/v1/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domainId)}/verify`);
    }

    /** Deletes a custom domain and its Routes; the default Domain cannot be deleted. */
    deleteDomain(projectId: Id, domainId: Id): Promise<ApiResult<void>> {
        return this.#call('DELETE', `/v1/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domainId)}`);
    }

    listRoutes(projectId: Id, domainId: Id): Promise<ApiResult<Route[]>> {
        return this.#call('GET', `/v1/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domainId)}/routes`);
    }

    /** Serves a Bucket below a path prefix of the Domain, within one operator pass. */
    createRoute(projectId: Id, domainId: Id, input: RouteInput): Promise<ApiResult<Route>> {
        return this.#call('POST', `/v1/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domainId)}/routes`, input);
    }

    deleteRoute(projectId: Id, domainId: Id, routeId: Id): Promise<ApiResult<void>> {
        return this.#call(
            'DELETE',
            `/v1/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domainId)}/routes/${encodeURIComponent(routeId)}`,
        );
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
