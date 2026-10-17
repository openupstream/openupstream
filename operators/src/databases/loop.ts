/**
 * The Databases operator: a reconcile pass every interval, with rows from
 * the control plane (ARCHITECTURE.md, decision 54). Level-triggered: each
 * pass applies the whole desired state, so a missed change or a restart
 * costs at most one interval.
 */
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

/** Runs passes until `signal` aborts; the next pass starts `intervalMs` after the last one ended. */
export async function runDatabasesOperator(
    pass: () => Promise<PassLog>,
    intervalMs: number,
    log: (entry: PassLog) => void,
    signal: AbortSignal,
): Promise<void> {
    while (!signal.aborted) {
        log(await pass());
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, intervalMs);
            signal.addEventListener(
                'abort',
                () => {
                    clearTimeout(timer);
                    resolve();
                },
                { once: true },
            );
        });
    }
}
