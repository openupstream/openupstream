/**
 * `oup service logs` and `oup job logs`: the log stream (ARCHITECTURE.md,
 * "Observability and customer logs"), printed as it arrives.
 */
import { LOG_LIMITS, type LogEntry } from '@openupstream/sdk';

/** The part of a pod's name that tells its replicas apart: what follows its last hyphen. */
export const podSuffix = (pod: string): string => pod.slice(pod.lastIndexOf('-') + 1);

/**
 * One entry as a line: with `prefix`, which replica it came from, and
 * `previous` when the container wrote it before its last restart; with
 * `timestamps`, the time first.
 */
export const formatLogEntry = (entry: LogEntry, options: { readonly prefix: boolean; readonly timestamps: boolean }): string => {
    const source = [...(options.prefix ? [podSuffix(entry.pod)] : []), ...(entry.previous ? ['previous'] : [])];
    return [...(options.timestamps ? [entry.time] : []), ...(source.length === 0 ? [] : [`[${source.join(' ')}]`]), entry.line].join(' ');
};

/** `--tail` as a number of lines; an error message when it is not one the API takes. */
export const parseTail = (value: string | undefined): { readonly ok: true; readonly value: number | undefined } | { readonly ok: false; readonly error: string } => {
    if (value === undefined) {
        return { ok: true, value: undefined };
    }
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n <= LOG_LIMITS.maxTailLines
        ? { ok: true, value: n }
        : { ok: false, error: `--tail must be a whole number from 0 to ${LOG_LIMITS.maxTailLines}, not ${value}` };
};
