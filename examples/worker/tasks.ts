/**
 * The worker demo as pure parts: the queue it works on, the arguments of
 * its jobs, the worker loop and the wait for a batch, so the tests of the
 * loops need no database.
 */
import { createHash } from 'node:crypto';

export interface Task {
    readonly id: string;
    readonly payload: string;
}

export interface Progress {
    readonly done: number;
    /** Done tasks per worker, the pod's hostname. */
    readonly byWorker: Readonly<Record<string, number>>;
}

export interface TaskQueue {
    /**
     * Takes the oldest open task no other worker holds, runs `work` on it
     * and stores the result, in one transaction: a worker that stops or
     * fails midway leaves the task open for the next. False when no task
     * is open.
     */
    takeOne(work: (task: Task) => Promise<string>): Promise<boolean>;
    /** Adds `count` open tasks as one batch; returns its id. */
    enqueue(count: number): Promise<string>;
    progress(batch: string): Promise<Progress>;
    /** Deletes the tasks done more than `hours` ago; returns how many. */
    deleteDone(hours: number): Promise<number>;
}

export type Parsed = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: string };

/** A whole number from a job's argument, `fallback` when there is none. */
export function parseWhole(arg: string | undefined, name: string, fallback: number, min: number, max: number): Parsed {
    if (arg === undefined) {
        return { ok: true, value: fallback };
    }
    const value = Number(arg);
    return /^\d+$/.test(arg) && value >= min && value <= max
        ? { ok: true, value }
        : { ok: false, error: `${name} is a whole number from ${min} to ${max}, not ${arg}` };
}

/** What a task computes: the SHA-256 of its payload, in hex. */
export const digest = (payload: string): string => createHash('sha256').update(payload).digest('hex');

/** Waits `ms`, or less when `signal` aborts first. Never rejects. */
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });

export interface LoopOptions {
    /** Ends the loop after the task at hand, and cuts a wait short. */
    readonly signal: AbortSignal;
    /** The wait when no task is open: no LISTEN through the Pooler in transaction mode, so the worker polls. */
    readonly idleMs: number;
    /** The wait after a failure, such as no database during a failover. */
    readonly retryMs: number;
    readonly log: (entry: Record<string, unknown>) => void;
    readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Takes tasks until `signal` aborts; returns how many it did. A failing
 * database is logged and retried, never the end of the process.
 */
export async function runWorker(queue: TaskQueue, work: (task: Task) => Promise<string>, options: LoopOptions): Promise<number> {
    const wait = options.wait ?? sleep;
    let done = 0;
    while (!options.signal.aborted) {
        const outcome = await queue.takeOne(work).then(
            (took) => ({ ok: true, took }) as const,
            (error: unknown) => ({ ok: false, error: String(error) }) as const,
        );
        if (!outcome.ok) {
            options.log({ msg: 'taking a task failed', error: outcome.error });
            await wait(options.retryMs, options.signal);
        } else if (outcome.took) {
            done += 1;
        } else {
            await wait(options.idleMs, options.signal);
        }
    }
    return done;
}

/**
 * Waits until all `count` tasks of `batch` are done and returns who did
 * them; the Job's timeout ends a wait that never gets there. Logs the
 * progress whenever it changed, and failures, which it retries.
 */
export async function waitForBatch(
    queue: TaskQueue,
    batch: string,
    count: number,
    options: { readonly intervalMs: number; readonly log: (entry: Record<string, unknown>) => void; readonly wait?: (ms: number) => Promise<void> },
): Promise<Progress> {
    const wait = options.wait ?? sleep;
    let last = -1;
    for (;;) {
        const outcome = await queue.progress(batch).then(
            (progress) => ({ ok: true, progress }) as const,
            (error: unknown) => ({ ok: false, error: String(error) }) as const,
        );
        if (!outcome.ok) {
            options.log({ msg: 'reading the progress failed', error: outcome.error });
        } else if (outcome.progress.done >= count) {
            return outcome.progress;
        } else if (outcome.progress.done !== last) {
            last = outcome.progress.done;
            options.log({ msg: 'waiting for the workers', batch, done: last, count });
        }
        await wait(options.intervalMs);
    }
}
