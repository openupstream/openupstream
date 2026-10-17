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

export interface ClientOptions {
    baseUrl?: string;
    token: string;
}

export class OpenUpstreamClient {
    readonly baseUrl: string;
    readonly #token: string;

    constructor(options: ClientOptions) {
        this.baseUrl = options.baseUrl ?? 'https://api.openupstream.com';
        this.#token = options.token;
    }

    /** Placeholder until the control plane exposes its first endpoint. */
    async health(): Promise<{ ok: boolean }> {
        const res = await fetch(`${this.baseUrl}/v1/health`, {
            headers: { authorization: `Bearer ${this.#token}` },
        });
        return { ok: res.ok };
    }
}
