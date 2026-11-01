/** Polling the API until something is done: a Service running, a Job ready, a run finished. */

type Read<T> = () => Promise<
    { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly message: string; readonly status?: number } }
>;

const NOT_FOUND = 404;

/**
 * Reads until `done` holds, or the time is up; every state it passes
 * through is reported once. A failed read is retried until the time is up,
 * except a 404: what was waited for is gone (deleted, stopped), and no
 * later read brings it back.
 */
export async function waitUntil<T extends { readonly state: string }>(
    read: Read<T>,
    done: (value: T) => boolean,
    options: { readonly timeoutMs: number; readonly intervalMs: number; readonly report: (state: T['state']) => void },
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string }> {
    const deadline = Date.now() + options.timeoutMs;
    let reported: T['state'] | undefined;
    for (;;) {
        const current = await read();
        if (current.ok && current.value.state !== reported) {
            reported = current.value.state;
            options.report(reported);
        }
        if (current.ok && done(current.value)) {
            return { ok: true, value: current.value };
        }
        if (!current.ok && current.error.status === NOT_FOUND) {
            return { ok: false, error: `gone: ${current.error.message}` };
        }
        if (Date.now() >= deadline) {
            return { ok: false, error: current.ok ? `still ${current.value.state} after ${options.timeoutMs / 1000} s` : current.error.message };
        }
        await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    }
}
