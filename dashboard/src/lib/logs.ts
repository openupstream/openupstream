import type { LogEntry } from '@openupstream/sdk';

/** How many lines an open log keeps: the oldest go first. */
export const MAX_LINES = 2000;

/** The lines with the new ones after them, the newest `max` of both. */
export const appended = (lines: readonly LogEntry[], more: readonly LogEntry[], max: number = MAX_LINES): readonly LogEntry[] =>
    more.length === 0 ? lines : [...lines, ...more].slice(-max);

/**
 * A pod's name short enough to tell replicas apart: what follows its last
 * hyphen (`svc-…-7c9d8f6b5-x2k4q` as `x2k4q`), the whole name without one.
 */
export const podLabel = (pod: string): string => pod.slice(pod.lastIndexOf('-') + 1);

/** The time of day a line was written, to the second, in the reader's time zone: Kubernetes' nanoseconds are more than Date reads. */
export const lineTime = (time: string): string => {
    const date = new Date(time.replace(/(\.\d{3})\d+/, '$1'));
    return Number.isNaN(date.getTime()) ? time : date.toLocaleTimeString([], { hour12: false });
};

/** Whether the lines come from more than one pod, so each has to say which. */
export const severalPods = (lines: readonly Pick<LogEntry, 'pod'>[]): boolean => lines.some((line) => line.pod !== lines[0]?.pod);
