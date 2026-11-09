/**
 * The Databases operator: a reconcile pass every interval, with rows from
 * the control plane (ARCHITECTURE.md, decision 54). Level-triggered: each
 * pass applies the whole desired state, so a missed change or a restart
 * costs at most one interval.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { FetchRows } from '../control-plane.js';
import type { Kube } from '../kube.js';
import type { DatabaseConfig } from './manifests.js';
import { type ReconcileOptions, reconcileDatabases } from './reconcile.js';

export interface PassLog {
    readonly msg: string;
    readonly [field: string]: unknown;
}

/** One pass, reduced to a log entry. Never throws. */
export async function databasesPass(
    fetchRows: FetchRows,
    kube: Kube,
    config: DatabaseConfig,
    options: ReconcileOptions,
): Promise<PassLog> {
    const rows = await fetchRows();
    if (!rows.ok) {
        return { msg: 'cannot get Database rows', error: rows.error };
    }
    const result = await reconcileDatabases(kube, rows.value, config, options);
    if (!result.ok) {
        return { msg: 'reconcile pass failed', error: result.error };
    }
    const { applied, invalid, failed } = result.value;
    return {
        msg: 'reconcile pass done',
        databases: rows.value.length,
        applied: applied.length,
        ...(invalid.length === 0 ? {} : { invalid }),
        ...(failed.length === 0 ? {} : { failed }),
    };
}

/**
 * The wait between passes, which something outside the loop can cut short:
 * a Node that joined or changed its addresses (decision 105). A wake during
 * a pass makes the next one start right after it.
 */
export interface Wakeup {
    readonly wake: () => void;
    readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export function wakeup(): Wakeup {
    let pending = false;
    let cutShort: AbortController | undefined;
    return {
        wake: () => {
            pending = true;
            cutShort?.abort();
        },
        sleep: async (ms, signal) => {
            if (!pending) {
                cutShort = new AbortController();
                // Rejects when stopped or woken, which only ends the wait early.
                await sleep(ms, undefined, { signal: AbortSignal.any([signal, cutShort.signal]) }).catch(() => undefined);
                cutShort = undefined;
            }
            pending = false;
        },
    };
}

/** Runs passes until `signal` aborts; the next pass starts `intervalMs` after the last one ended, or when woken. */
export async function runPasses(
    pass: () => Promise<PassLog>,
    intervalMs: number,
    log: (entry: PassLog) => void,
    signal: AbortSignal,
    wait: Wakeup = wakeup(),
): Promise<void> {
    while (!signal.aborted) {
        log(await pass());
        await wait.sleep(intervalMs, signal);
    }
}
