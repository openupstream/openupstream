/**
 * The log stream (ARCHITECTURE.md, "Observability and customer logs";
 * decision 21): the output of a Service's replicas or of a run, read from
 * the Kubernetes logs API while the client waits. Nothing is retained.
 *
 * Without `follow` it answers the last `tail` lines of every container,
 * sorted by time, then ends. With `follow` it sends those as they arrive,
 * then new lines, and every `pollMs` lists the pods again: a replica that
 * starts during a rollout is added, a container that restarted is read
 * again from the last line sent. It ends at `maxMs`, when the client goes,
 * or once no pod is left that can write anything more.
 */
import { COMPUTE_SITES, type LogEntry, type Site } from '@openupstream/sdk';
import type { ControlPlaneKube, PodContainer, PodInfo } from '../kube.js';
import { type Result, ok } from '../result.js';

export type LogKube = Pick<ControlPlaneKube, 'listPods' | 'nodeSite' | 'podLog'>;

export interface LogStreamOptions {
    readonly namespace: string;
    /** The label selector of the pods, e.g. `openupstream.io/service-id=…`. */
    readonly selector: string;
    readonly tail: number;
    readonly follow: boolean;
    readonly pollMs: number;
    readonly maxMs: number;
    readonly log?: ((entry: Record<string, unknown>) => void) | undefined;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * A line as Kubernetes sends it with `timestamps=true`: the time, a space,
 * the line. undefined for one without a time: the kubelet answers 200 with
 * a sentence of its own when it cannot read a log (`unable to retrieve
 * container logs for …`), which is not the container's output.
 */
export const parseLogLine = (raw: string): { time: string; line: string } | undefined => {
    const space = raw.indexOf(' ');
    const time = space === -1 ? raw : raw.slice(0, space);
    return RFC3339.test(time) ? { time, line: space === -1 ? '' : raw.slice(space + 1) } : undefined;
};

/**
 * A key that sorts like the time it stands for. RFC 3339 as the kubelet
 * writes it drops trailing zeros of the fraction, so the strings
 * themselves do not sort.
 */
export const timeKey = (time: string): string => {
    const match = /^(.*?T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$/.exec(time);
    return match === null ? time : `${match[1]}.${(match[2] ?? '').padEnd(9, '0')}${match[3]}`;
};

const siteOf = (zone: string | undefined): Site | null => COMPUTE_SITES.find((site) => site === zone) ?? null;

/**
 * Which logs of a container hold output, as the kubelet serves them:
 * - `running`: the current one, and after a restart the previous one,
 *   what the container wrote before it crashed;
 * - `waiting` after a restart (CrashLoopBackOff): the previous one, the
 *   run that crashed;
 * - `terminated`: the current one, the container that ended; its previous
 *   one may already be removed.
 */
export const logsOf = (container: PodContainer): { readonly previous: boolean; readonly current: boolean } => ({
    previous: container.restartCount > 0 && container.state !== 'terminated',
    current: container.state !== 'waiting',
});

const readable = (container: PodContainer) => {
    const logs = logsOf(container);
    return logs.previous || logs.current;
};

/** A queue the readers push into and the response reads from. */
const channel = <T>() => {
    const queued: T[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    const notify = () => {
        wake?.();
        wake = undefined;
    };
    return {
        push: (value: T) => {
            queued.push(value);
            notify();
        },
        close: () => {
            closed = true;
            notify();
        },
        /** Wakes the reader without queueing anything. */
        poke: notify,
        /** Resolves once something is queued, the channel is closed, or `ms` have passed. */
        waitFor: (ms: number) =>
            queued.length > 0 || closed
                ? Promise.resolve()
                : new Promise<void>((resolve) => {
                      const timer = setTimeout(resolve, ms);
                      wake = () => {
                          clearTimeout(timer);
                          resolve();
                      };
                  }),
        take: () => queued.splice(0),
        get closed() {
            return closed;
        },
    };
};

/**
 * Lists the pods once, so an unreachable Kubernetes answers before the
 * stream starts; then the entries, as the module comment says.
 */
export async function openLogStream(kube: LogKube, options: LogStreamOptions, signal: AbortSignal): Promise<Result<AsyncIterable<LogEntry>, string>> {
    const pods = await kube.listPods(options.namespace, options.selector);
    if (!pods.ok) {
        return pods;
    }
    const sites = new Map<string, Promise<Site | null>>();
    const site = (pod: PodInfo): Promise<Site | null> => {
        if (pod.nodeName === undefined) {
            return Promise.resolve(null);
        }
        const known = sites.get(pod.nodeName);
        if (known !== undefined) {
            return known;
        }
        const looked = kube.nodeSite(pod.nodeName).then((result) => (result.ok ? siteOf(result.value) : null));
        sites.set(pod.nodeName, looked);
        return looked;
    };
    return ok(options.follow ? follow(kube, options, pods.value, site, signal) : snapshot(kube, options, pods.value, site, signal));
}

type SiteOf = (pod: PodInfo) => Promise<Site | null>;

/** Reads one container's log into entries; a log that cannot be opened is logged and skipped. */
async function readInto(
    kube: LogKube,
    options: LogStreamOptions,
    pod: PodInfo,
    container: PodContainer,
    read: { readonly follow: boolean; readonly previous: boolean; readonly tailLines?: number; readonly sinceTime?: string; readonly after?: string },
    site: Site | null,
    emit: (entry: LogEntry) => void,
    signal: AbortSignal,
): Promise<void> {
    const { after, ...logOptions } = read;
    const lines = await kube.podLog(options.namespace, pod.name, container.name, logOptions, signal);
    if (!lines.ok) {
        options.log?.({ msg: 'cannot read a log', pod: pod.name, container: container.name, error: lines.error });
        return;
    }
    const afterKey = after === undefined ? undefined : timeKey(after);
    for await (const raw of lines.value) {
        const parsed = parseLogLine(raw);
        if (parsed === undefined) {
            options.log?.({ msg: 'a log line without a time', pod: pod.name, container: container.name, line: raw.slice(0, 200) });
        } else if (afterKey === undefined || timeKey(parsed.time) > afterKey) {
            // sinceTime counts whole seconds: lines of that second sent already come again, and are dropped here.
            emit({ pod: pod.name, site, time: parsed.time, line: parsed.line, previous: read.previous });
        }
    }
}

async function* snapshot(kube: LogKube, options: LogStreamOptions, pods: readonly PodInfo[], siteOf: SiteOf, signal: AbortSignal): AsyncIterable<LogEntry> {
    const entries: LogEntry[] = [];
    const emit = (entry: LogEntry) => entries.push(entry);
    await Promise.all(
        pods.flatMap((pod) =>
            pod.containers.filter(readable).map(async (container) => {
                const site = await siteOf(pod);
                const logs = logsOf(container);
                if (logs.previous) {
                    await readInto(kube, options, pod, container, { follow: false, previous: true, tailLines: options.tail }, site, emit, signal);
                }
                if (logs.current) {
                    await readInto(kube, options, pod, container, { follow: false, previous: false, tailLines: options.tail }, site, emit, signal);
                }
            }),
        ),
    );
    yield* entries.sort((a, b) => (timeKey(a.time) < timeKey(b.time) ? -1 : timeKey(a.time) > timeKey(b.time) ? 1 : 0));
}

/** What `follow` keeps per container: whether a read is open, and the last line's time. */
interface Followed {
    active: boolean;
    lastTime: string | undefined;
    stop: AbortController;
}

async function* follow(kube: LogKube, options: LogStreamOptions, initial: readonly PodInfo[], siteOf: SiteOf, signal: AbortSignal): AsyncIterable<LogEntry> {
    const queue = channel<LogEntry>();
    const followed = new Map<string, Followed>();
    const deadline = Date.now() + options.maxMs;
    /** Set when a read ends, so the pods are listed at once rather than at the next poll: a finished run ends the stream. */
    let readEnded = false;
    const anyActive = () => [...followed.values()].some((entry) => entry.active);
    const stopAll = () => {
        for (const entry of followed.values()) {
            entry.stop.abort();
        }
        queue.close();
    };
    signal.addEventListener('abort', stopAll, { once: true });
    const timer = setTimeout(stopAll, options.maxMs);

    /** Opens a read of the container unless one is open; the first one with the previous container's tail. */
    const start = (pod: PodInfo, container: PodContainer) => {
        const key = `${pod.name}/${container.name}`;
        const known = followed.get(key);
        if (known?.active === true || queue.closed) {
            return;
        }
        const entry: Followed = { active: true, lastTime: known?.lastTime, stop: new AbortController() };
        followed.set(key, entry);
        const emit = (logEntry: LogEntry) => {
            entry.lastTime = logEntry.time;
            queue.push(logEntry);
        };
        const stopped = AbortSignal.any([entry.stop.signal, signal]);
        void (async () => {
            const site = await siteOf(pod);
            const logs = logsOf(container);
            // Later crashes need no previous log: the read of the running container had their lines.
            if (known === undefined && logs.previous) {
                await readInto(kube, options, pod, container, { follow: false, previous: true, tailLines: options.tail }, site, emit, stopped);
            }
            if (logs.current) {
                const from =
                    entry.lastTime === undefined
                        ? { tailLines: options.tail }
                        : { sinceTime: entry.lastTime.replace(/\.\d+/, ''), after: entry.lastTime };
                await readInto(kube, options, pod, container, { follow: true, previous: false, ...from }, site, emit, stopped);
            }
            entry.active = false;
            readEnded = true;
            queue.poke();
        })();
    };

    /** Starts what can be read; true while anything is open or may still write. */
    const step = (pods: readonly PodInfo[]): boolean => {
        const present = new Set(pods.flatMap((pod) => pod.containers.map((container) => `${pod.name}/${container.name}`)));
        // A read of a pod that is gone may hang on a connection that died: stop it.
        for (const [key, entry] of followed) {
            if (!present.has(key) && entry.active) {
                entry.stop.abort();
            }
        }
        for (const pod of pods) {
            for (const container of pod.containers) {
                const known = followed.get(`${pod.name}/${container.name}`);
                // A terminated container is read once; a running one again after its read ended (it restarted).
                if (known === undefined ? readable(container) : container.state === 'running') {
                    start(pod, container);
                }
            }
        }
        const mayWrite = pods.some((pod) => pod.containers.some((container) => container.state !== 'terminated'));
        return anyActive() || mayWrite;
    };

    try {
        let going = step(initial);
        let nextPoll = Date.now() + options.pollMs;
        while (going && !queue.closed && Date.now() < deadline) {
            await queue.waitFor(Math.max(0, nextPoll - Date.now()));
            yield* queue.take();
            const due = Date.now() >= nextPoll || (readEnded && !anyActive());
            readEnded = false;
            if (due && !queue.closed) {
                nextPoll = Date.now() + options.pollMs;
                const pods = await kube.listPods(options.namespace, options.selector);
                if (pods.ok) {
                    going = step(pods.value);
                } else {
                    options.log?.({ msg: 'cannot list pods for a log stream', selector: options.selector, error: pods.error });
                }
            }
        }
        yield* queue.take();
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', stopAll);
        stopAll();
    }
}
