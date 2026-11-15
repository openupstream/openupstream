/**
 * Instant queries against the platform's Prometheus (decision 106), for
 * storage auto-grow (decision 111) and metering (decision 114).
 */
import { type Result, err, ok } from './result.js';

export interface PrometheusSample {
    readonly labels: Readonly<Record<string, string>>;
    readonly value: number;
}

/** An instant query, at `time` or now. */
export type PrometheusQuery = (query: string, time?: Date) => Promise<Result<PrometheusSample[], string>>;

export const prometheusClient =
    (url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 30_000): PrometheusQuery =>
    async (query, time) => {
        const params = new URLSearchParams({ query, ...(time === undefined ? {} : { time: String(time.getTime() / 1000) }) });
        const response = await fetchImpl(`${url.replace(/\/$/, '')}/api/v1/query?${params}`, {
            signal: AbortSignal.timeout(timeoutMs),
        }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
        if (response instanceof Error) {
            return err(response.message);
        }
        if (!response.ok) {
            return err(`Prometheus answered ${response.status}`);
        }
        const body = (await response.json()) as {
            data?: { result?: { metric?: Record<string, string>; value?: [number, string] }[] };
        };
        return ok((body.data?.result ?? []).map((sample) => ({ labels: sample.metric ?? {}, value: Number(sample.value?.[1]) })));
    };
