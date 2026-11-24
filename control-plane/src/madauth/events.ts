/**
 * madAuth's events the control plane acts on (ARCHITECTURE.md, decision
 * 143), passed on by the sidecar to the internal API:
 *
 * - `user.deleted` removes the user from every Account;
 * - `user.api_key_revoked` drops the key's Postgres roles.
 *
 * madAuth sends an event once and does not retry, so the sidecar answers it
 * at once and keeps trying the control plane, which may be restarting, for
 * up to RETRY_FOR_MS. The attempts live in the sidecar's memory: an event
 * is lost if the sidecar itself restarts meanwhile, and the log says so.
 * Both calls are idempotent, so trying again is always safe.
 */
import { MADAUTH_ID, internalApiKeyPath, internalUserPath } from '@openupstream/sdk';

/** A call to the control plane's internal API for one event. */
export interface ControlPlaneCall {
    /** The madAuth event it passes on, for the log. */
    readonly event: string;
    readonly method: 'DELETE';
    readonly path: string;
}

const idOf = (value: unknown): string | undefined =>
    typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string' && MADAUTH_ID.test(value.id)
        ? value.id
        : undefined;

/**
 * The call an event asks for: undefined when the control plane does not act
 * on it, `malformed` when it should but the data lacks the ids.
 */
export const callFor = (type: string, data: Readonly<Record<string, unknown>>): ControlPlaneCall | 'malformed' | undefined => {
    if (type === 'user.deleted') {
        const subject = idOf(data['user']);
        return subject === undefined ? 'malformed' : { event: type, method: 'DELETE', path: internalUserPath(subject) };
    }
    if (type === 'user.api_key_revoked') {
        const subject = idOf(data['user']);
        const keyId = idOf(data['apiKey']);
        return subject === undefined || keyId === undefined
            ? 'malformed'
            : { event: type, method: 'DELETE', path: internalApiKeyPath(subject, keyId) };
    }
    return undefined;
};

/** `done`: the control plane acted; `retry`: it may later; `refused`: it never will (a 4xx). */
export interface SendResult {
    readonly outcome: 'done' | 'retry' | 'refused';
    readonly detail?: string;
}

export type Send = (call: ControlPlaneCall) => Promise<SendResult>;

/** How long the sidecar keeps trying one event: longer than a control plane rollout. */
export const RETRY_FOR_MS = 60 * 60 * 1000;
const FIRST_DELAY_MS = 1_000;
const MAX_DELAY_MS = 5 * 60 * 1000;

/** The wait after the `attempt`th failure (0-based): doubling from a second, at most five minutes. */
export const retryDelay = (attempt: number): number => Math.min(FIRST_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);

export interface DeliverDeps {
    readonly send: Send;
    readonly log: (entry: Record<string, unknown>) => void;
    /** Milliseconds, like Date.now. */
    readonly now: () => number;
    readonly sleep: (ms: number) => Promise<void>;
}

/** Tries `call` until it is done, refused, or RETRY_FOR_MS have passed; whether it was done. */
export async function deliver(call: ControlPlaneCall, deps: DeliverDeps): Promise<boolean> {
    const giveUpAt = deps.now() + RETRY_FOR_MS;
    const attempt = async (n: number): Promise<boolean> => {
        const result = await deps.send(call);
        if (result.outcome === 'done') {
            if (n > 0) {
                deps.log({ msg: 'madauth event passed on after retrying', event: call.event, attempts: n + 1 });
            }
            return true;
        }
        if (result.outcome === 'refused') {
            deps.log({ msg: 'madauth event refused by the control plane, not retried', event: call.event, detail: result.detail });
            return false;
        }
        const delay = retryDelay(n);
        if (deps.now() + delay > giveUpAt) {
            deps.log({ msg: 'madauth event given up: the control plane did not take it within an hour', event: call.event, attempts: n + 1, detail: result.detail });
            return false;
        }
        deps.log({ msg: 'madauth event not passed on yet, retrying', event: call.event, attempt: n + 1, inMs: delay, detail: result.detail });
        await deps.sleep(delay);
        return attempt(n + 1);
    };
    return attempt(0);
}

/**
 * Sends calls to the internal API at `url` with the projected ServiceAccount
 * token `token()` reads (rotated by the kubelet, so read every time). A 401
 * is retried, since the token may just have been rotated, as are 408, 429
 * and 5xx; other 4xx are refused.
 */
export const controlPlaneSender =
    (url: string, token: () => Promise<string>, fetcher: typeof fetch = fetch): Send =>
    async (call) => {
        const bearer = await token().then(
            (value) => value.trim(),
            (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
        );
        if (typeof bearer !== 'string') {
            return { outcome: 'retry', detail: `cannot read the token: ${bearer.error}` };
        }
        const response = await fetcher(new URL(call.path, url), {
            method: call.method,
            headers: { authorization: `Bearer ${bearer}` },
            signal: AbortSignal.timeout(10_000),
        }).then(
            (value) => value,
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        if (typeof response === 'string') {
            return { outcome: 'retry', detail: response };
        }
        if (response.ok) {
            return { outcome: 'done' };
        }
        const retried = response.status === 401 || response.status === 408 || response.status === 429 || response.status >= 500;
        return { outcome: retried ? 'retry' : 'refused', detail: `HTTP ${response.status}` };
    };
