/**
 * @openupstream/sdk
 *
 * Typed client for the openupstream control plane API. Used by the CLI and
 * the dashboard; published to npm for customers who want to automate their
 * own account.
 *
 * The API surface is defined here first and implemented in control-plane/.
 */

export const SDK_VERSION = '0.7.0';

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
    DatabasePatch,
    DatabaseProxy,
    DatabaseProxyInput,
    Domain,
    Id,
    JobDetails,
    JobInput,
    JobPatch,
    JobRun,
    JobRunInput,
    LogEntry,
    LogQuery,
    NodesReport,
    AccountToken,
    AccountTokenInput,
    AccountTokenPatch,
    AccountTokenRoll,
    AccountTokenWithSecret,
    Grant,
    GrantInput,
    Member,
    MemberPatch,
    Project,
    ProjectInput,
    ProjectUsage,
    Route,
    RouteInput,
    Secret,
    SecretInput,
    ServiceDetails,
    ServiceInput,
    ServicePatch,
    SiteInfo,
} from './model.js';

/** The API is under `/api` of the platform's host (ARCHITECTURE.md, decision 120). */
export const DEFAULT_API_URL = 'https://console.openupstream.com/api';

export interface ClientOptions {
    baseUrl?: string;
    /** A madAuth session token, an access token of `oup`, one of the user's madAuth API keys (`madauth_…`) or an Account token (`oup_tok_…`). */
    token: string;
}

/**
 * In a browser on the dashboard's origin, which is the API's too: no token,
 * the browser sends madAuth's session cookie along. `baseUrl` can be a path
 * there, e.g. `/api`. To another origin the browser sends no cookie, and
 * the API answers 401.
 */
export interface CookieSessionOptions {
    baseUrl?: string;
    session: 'cookie';
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
    /** The credential of every request: the token as a header, or the browser's cookie. */
    readonly #auth: { readonly headers: Record<string, string>; readonly credentials?: 'same-origin' };

    constructor(options: ClientOptions | CookieSessionOptions) {
        this.baseUrl = options.baseUrl ?? DEFAULT_API_URL;
        this.#auth = 'token' in options ? { headers: { authorization: `Bearer ${options.token}` } } : { headers: {}, credentials: 'same-origin' };
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

    /** The Account's Members with their roles and grants; owners and developers see all, a Member without a role themselves. */
    listMembers(accountId: Id): Promise<ApiResult<Member[]>> {
        return this.#call('GET', `/v1/accounts/${encodeURIComponent(accountId)}/members`);
    }

    /** Gives a Member another role; owners only, never with an API key. An Account always keeps an owner (409). */
    updateMember(accountId: Id, memberId: Id, patch: MemberPatch): Promise<ApiResult<Member>> {
        return this.#call('PATCH', `/v1/accounts/${encodeURIComponent(accountId)}/members/${encodeURIComponent(memberId)}`, patch);
    }

    /**
     * Gives a Member access to one Database at a level, or another level
     * (decision 139); owners only, never with an API key. A lower level drops
     * the Member's Postgres roles above it while they have no role.
     */
    setGrant(accountId: Id, memberId: Id, databaseId: Id, input: GrantInput): Promise<ApiResult<Grant>> {
        return this.#call('PUT', grantPath(accountId, memberId, databaseId), input);
    }

    /** Takes a Member's grant on a Database away, and with it their Postgres roles there while they have no role. */
    removeGrant(accountId: Id, memberId: Id, databaseId: Id): Promise<ApiResult<void>> {
        return this.#call('DELETE', grantPath(accountId, memberId, databaseId));
    }

    /**
     * Removes a Member, `me` for the caller (leaving the Account); others
     * only by an owner, never with an API key. Their Postgres roles in the
     * Account's Databases are dropped. An Account always keeps an owner (409).
     */
    removeMember(accountId: Id, memberId: Id | 'me'): Promise<ApiResult<void>> {
        return this.#call('DELETE', `/v1/accounts/${encodeURIComponent(accountId)}/members/${encodeURIComponent(memberId)}`);
    }

    /** The Account's tokens, without their secrets; owners and developers see them, never with an Account token. */
    listAccountTokens(accountId: Id): Promise<ApiResult<AccountToken[]>> {
        return this.#call('GET', accountTokenPath(accountId));
    }

    /** A new Account token and its secret, shown only now (decision 144); owners only, never with an API key. */
    createAccountToken(accountId: Id, input: AccountTokenInput): Promise<ApiResult<AccountTokenWithSecret>> {
        return this.#call('POST', accountTokenPath(accountId), input);
    }

    /** Renames an Account token or changes its role; owners only, never with an API key. */
    updateAccountToken(accountId: Id, tokenId: Id, patch: AccountTokenPatch): Promise<ApiResult<AccountToken>> {
        return this.#call('PATCH', accountTokenPath(accountId, tokenId), patch);
    }

    /** A new secret and expiry for an Account token; the previous secret works 24 hours more. Owners only. */
    rollAccountToken(accountId: Id, tokenId: Id, input: AccountTokenRoll): Promise<ApiResult<AccountTokenWithSecret>> {
        return this.#call('POST', `${accountTokenPath(accountId, tokenId)}/roll`, input);
    }

    /** Revokes an Account token at once and drops its Postgres roles; owners only, never with an API key. */
    deleteAccountToken(accountId: Id, tokenId: Id): Promise<ApiResult<void>> {
        return this.#call('DELETE', accountTokenPath(accountId, tokenId));
    }

    /** Gives an Account token access to one Database at a level, or another level; as setGrant for a Member. */
    setAccountTokenGrant(accountId: Id, tokenId: Id, databaseId: Id, input: GrantInput): Promise<ApiResult<Grant>> {
        return this.#call('PUT', `${accountTokenPath(accountId, tokenId)}/grants/${encodeURIComponent(databaseId)}`, input);
    }

    /** Takes an Account token's grant on a Database away, and with it its Postgres roles there while it has no role. */
    removeAccountTokenGrant(accountId: Id, tokenId: Id, databaseId: Id): Promise<ApiResult<void>> {
        return this.#call('DELETE', `${accountTokenPath(accountId, tokenId)}/grants/${encodeURIComponent(databaseId)}`);
    }

    /** The compute Sites, where Databases, Services and Jobs can run; one is the default. */
    listSites(): Promise<ApiResult<SiteInfo[]>> {
        return this.#call('GET', '/v1/sites');
    }

    /** Every node and what is wrong with the Site labels; only for madAuth's `admin` role, signed in (ADR-0008). */
    listNodes(): Promise<ApiResult<NodesReport>> {
        return this.#call('GET', '/v1/admin/nodes');
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

    /** What every Resource of the Project uses now, with its instances. */
    getUsage(projectId: Id): Promise<ApiResult<ProjectUsage>> {
        return this.#call('GET', `/v1/projects/${encodeURIComponent(projectId)}/usage`);
    }

    listDatabases(projectId: Id): Promise<ApiResult<DatabaseDetails[]>> {
        return this.#call('GET', `/v1/projects/${encodeURIComponent(projectId)}/databases`);
    }

    createDatabase(projectId: Id, input: DatabaseInput): Promise<ApiResult<DatabaseDetails>> {
        return this.#call('POST', `/v1/projects/${encodeURIComponent(projectId)}/databases`, input);
    }

    /**
     * The caller's own Postgres role for the Database at a level, created on
     * the first ask, and the tunnel to reach it with (decision 126). An API
     * key gets roles of its own and needs `openupstream:write`.
     */
    openDatabaseProxy(projectId: Id, databaseId: Id, input: DatabaseProxyInput = {}): Promise<ApiResult<DatabaseProxy>> {
        return this.#call('POST', `/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/proxy`, input);
    }

    getDatabase(projectId: Id, databaseId: Id): Promise<ApiResult<DatabaseDetails>> {
        return this.#call('GET', `/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}`);
    }

    /** Resizes the Database; the operator applies it within one pass (`resizing` until then). */
    updateDatabase(projectId: Id, databaseId: Id, patch: DatabasePatch): Promise<ApiResult<DatabaseDetails>> {
        return this.#call('PATCH', `/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}`, patch);
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

    listServices(projectId: Id): Promise<ApiResult<ServiceDetails[]>> {
        return this.#call('GET', `/v1/projects/${encodeURIComponent(projectId)}/services`);
    }

    /** Resolves the image's tag to a digest now and deploys it pinned; running within one operator pass. */
    createService(projectId: Id, input: ServiceInput): Promise<ApiResult<ServiceDetails>> {
        return this.#call('POST', `/v1/projects/${encodeURIComponent(projectId)}/services`, input);
    }

    getService(projectId: Id, serviceId: Id): Promise<ApiResult<ServiceDetails>> {
        return this.#call('GET', `/v1/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}`);
    }

    /** Changes the Service; a new image or new registry credentials resolve the tag again. */
    updateService(projectId: Id, serviceId: Id, patch: ServicePatch): Promise<ApiResult<ServiceDetails>> {
        return this.#call('PATCH', `/v1/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}`, patch);
    }

    /** Resolves the Service's tag again and deploys what it points at now. */
    deployService(projectId: Id, serviceId: Id): Promise<ApiResult<ServiceDetails>> {
        return this.#call('POST', `/v1/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/deploy`);
    }

    /** Deletes the Service; refused while a Route serves it. */
    deleteService(projectId: Id, serviceId: Id): Promise<ApiResult<void>> {
        return this.#call('DELETE', `/v1/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}`);
    }

    listJobs(projectId: Id): Promise<ApiResult<JobDetails[]>> {
        return this.#call('GET', `/v1/projects/${encodeURIComponent(projectId)}/jobs`);
    }

    /** Resolves the image's tag to a digest now; the Job is ready to run within one operator pass. */
    createJob(projectId: Id, input: JobInput): Promise<ApiResult<JobDetails>> {
        return this.#call('POST', `/v1/projects/${encodeURIComponent(projectId)}/jobs`, input);
    }

    getJob(projectId: Id, jobId: Id): Promise<ApiResult<JobDetails>> {
        return this.#call('GET', `/v1/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}`);
    }

    /** Changes the Job; a new image or new registry credentials resolve the tag again. */
    updateJob(projectId: Id, jobId: Id, patch: JobPatch): Promise<ApiResult<JobDetails>> {
        return this.#call('PATCH', `/v1/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}`, patch);
    }

    /** Resolves the Job's tag again; later runs start what it points at now. */
    deployJob(projectId: Id, jobId: Id): Promise<ApiResult<JobDetails>> {
        return this.#call('POST', `/v1/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/deploy`);
    }

    /** Deletes the Job; its runs, running ones included, are stopped and removed. */
    deleteJob(projectId: Id, jobId: Id): Promise<ApiResult<void>> {
        return this.#call('DELETE', `/v1/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}`);
    }

    /** Starts a One-off job from the Job's current template; 409 while the Job is still deploying. */
    startJobRun(projectId: Id, jobId: Id, input: JobRunInput = {}): Promise<ApiResult<JobRun>> {
        return this.#call('POST', `/v1/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/runs`, input);
    }

    /** The Job's runs, newest first, scheduled and started alike. */
    listJobRuns(projectId: Id, jobId: Id): Promise<ApiResult<JobRun[]>> {
        return this.#call('GET', `/v1/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/runs`);
    }

    getJobRun(projectId: Id, jobId: Id, runId: string): Promise<ApiResult<JobRun>> {
        return this.#call(
            'GET',
            `/v1/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/runs/${encodeURIComponent(runId)}`,
        );
    }

    /** Stops the run if it is still going, and removes it. */
    deleteJobRun(projectId: Id, jobId: Id, runId: string): Promise<ApiResult<void>> {
        return this.#call(
            'DELETE',
            `/v1/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/runs/${encodeURIComponent(runId)}`,
        );
    }

    /** The Service's output from all its replicas, as a stream of entries; `signal` ends it early. */
    serviceLogs(projectId: Id, serviceId: Id, query: LogQuery = {}, signal?: AbortSignal): Promise<ApiResult<AsyncIterable<LogEntry>>> {
        return this.#stream(
            `/v1/projects/${encodeURIComponent(projectId)}/services/${encodeURIComponent(serviceId)}/logs${logSearch(query)}`,
            signal,
        );
    }

    /** A run's output, as a stream of entries; `signal` ends it early. */
    jobRunLogs(projectId: Id, jobId: Id, runId: string, query: LogQuery = {}, signal?: AbortSignal): Promise<ApiResult<AsyncIterable<LogEntry>>> {
        return this.#stream(
            `/v1/projects/${encodeURIComponent(projectId)}/jobs/${encodeURIComponent(jobId)}/runs/${encodeURIComponent(runId)}/logs${logSearch(query)}`,
            signal,
        );
    }

    /** The Project's Secrets, names only: a value is never returned. */
    listSecrets(projectId: Id): Promise<ApiResult<Secret[]>> {
        return this.#call('GET', `/v1/projects/${encodeURIComponent(projectId)}/secrets`);
    }

    /** Creates the Secret or replaces its value; the Project's Services get it in their environment. */
    putSecret(projectId: Id, input: SecretInput): Promise<ApiResult<Secret>> {
        return this.#call('PUT', `/v1/projects/${encodeURIComponent(projectId)}/secrets/${encodeURIComponent(input.name)}`, {
            value: input.value,
        });
    }

    deleteSecret(projectId: Id, name: string): Promise<ApiResult<void>> {
        return this.#call('DELETE', `/v1/projects/${encodeURIComponent(projectId)}/secrets/${encodeURIComponent(name)}`);
    }

    /** A GET whose answer is NDJSON, one entry per line, read as it arrives. */
    async #stream<T>(path: string, signal?: AbortSignal): Promise<ApiResult<AsyncIterable<T>>> {
        const response = await fetch(`${this.baseUrl}${path}`, {
            ...this.#auth,
            ...(signal === undefined ? {} : { signal }),
        }).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error: { status: 0, message: error instanceof Error ? error.message : String(error) } }),
        );
        if (!response.ok) {
            return response;
        }
        const isNdjson = response.value.headers.get('content-type')?.includes('application/x-ndjson') ?? false;
        if (response.value.ok && isNdjson && response.value.body !== null) {
            return { ok: true, value: ndjsonLines<T>(response.value.body) };
        }
        const parsed: unknown = await response.value.json().catch(() => undefined);
        const message =
            typeof parsed === 'object' && parsed !== null && 'error' in parsed && typeof parsed.error === 'string'
                ? parsed.error
                : response.value.ok
                  ? 'the API did not answer with a log stream'
                  : response.value.statusText;
        return { ok: false, error: { status: response.value.ok ? 0 : response.value.status, message } };
    }

    async #call<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
        const response = await fetch(`${this.baseUrl}${path}`, {
            method,
            ...this.#auth,
            headers: {
                ...this.#auth.headers,
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
        return { ok: false, error: { status: response.value.status, message: errorMessage(parsed, response.value.statusText) } };
    }
}

/**
 * The API's `error`, followed by what its `issues` say about each field
 * (a 400's `{error: 'invalid request', issues: [{path, message}]}`), so
 * the caller learns what to change; the HTTP status text without either.
 */
export function errorMessage(body: unknown, statusText: string): string {
    if (typeof body !== 'object' || body === null || !('error' in body) || typeof body.error !== 'string') {
        return statusText;
    }
    const issues = 'issues' in body && Array.isArray(body.issues) ? body.issues : [];
    const details = issues.flatMap((issue: unknown) =>
        typeof issue === 'object' && issue !== null && 'message' in issue && typeof issue.message === 'string'
            ? ['path' in issue && typeof issue.path === 'string' && issue.path !== '' ? `${issue.path}: ${issue.message}` : issue.message]
            : [],
    );
    return details.length === 0 ? body.error : `${body.error} (${details.join('; ')})`;
}

const accountTokenPath = (accountId: Id, tokenId?: Id): string =>
    `/v1/accounts/${encodeURIComponent(accountId)}/account-tokens${tokenId === undefined ? '' : `/${encodeURIComponent(tokenId)}`}`;

const grantPath = (accountId: Id, memberId: Id, databaseId: Id): string =>
    `/v1/accounts/${encodeURIComponent(accountId)}/members/${encodeURIComponent(memberId)}/grants/${encodeURIComponent(databaseId)}`;

const logSearch = (query: LogQuery): string => {
    const params = new URLSearchParams({
        ...(query.tail === undefined ? {} : { tail: String(query.tail) }),
        ...(query.follow === true ? { follow: 'true' } : {}),
    }).toString();
    return params === '' ? '' : `?${params}`;
};

/**
 * The JSON values of a body of NDJSON, one per non-empty line. Read with a
 * reader, not `for await` over the body, which Safari does not have; a
 * consumer that stops early cancels the body, which ends the request.
 */
export async function* ndjsonLines<T>(body: ReadableStream<Uint8Array>): AsyncIterable<T> {
    const decoder = new TextDecoder();
    const reader = body.getReader();
    let pending = '';
    try {
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
            pending += decoder.decode(chunk.value, { stream: true });
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            for (const line of lines.filter((candidate) => candidate.trim() !== '')) {
                yield JSON.parse(line) as T;
            }
        }
        const last = pending + decoder.decode();
        if (last.trim() !== '') {
            yield JSON.parse(last) as T;
        }
    } finally {
        // Also after an error or an abort, where cancelling again changes nothing.
        await reader.cancel().catch(() => undefined);
    }
}
