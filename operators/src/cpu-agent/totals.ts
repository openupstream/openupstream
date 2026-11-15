/**
 * The CPU agent's bookkeeping (ARCHITECTURE.md, "Metering and billing";
 * decision 113), as pure functions: every pod's CPU total since it started,
 * as the kernel counts it in the pod's cgroup, kept for a while after the
 * pod is gone, so Prometheus scrapes the final total of even a
 * 5-second Job run.
 */

/** One pod as the agent last read it. */
export interface Tracked {
    /** CPU seconds since the pod's cgroup was created: its whole life, sandbox (gVisor) included. */
    readonly seconds: number;
    /** Once known from the Kubernetes API; a pod may end before the agent has listed it. */
    readonly namespace?: string;
    readonly pod?: string;
    /** Set once a process was seen in its cgroup: a new cgroup is empty before its first process joins. */
    readonly ran?: true;
    /** When its cgroup was found gone, or empty after it ran: its total is final. */
    readonly endedAt?: number;
}

export type Totals = ReadonlyMap<string, Tracked>;

/** How long a pod's final total stays exported after it ended: several Prometheus scrapes. */
export const KEEP_MS = 15 * 60_000;

/**
 * A pod slice's directory name, under the systemd cgroup driver:
 * `kubepods-pod<uid>.slice` (Guaranteed) or `kubepods-<qos>-pod<uid>.slice`,
 * the uid's dashes as underscores. Undefined for anything else.
 */
export const podUidOf = (slice: string): string | undefined => {
    const match = /^kubepods(?:-(?:burstable|besteffort))?-pod([0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12})\.slice$/.exec(slice);
    return match?.[1]?.replace(/_/g, '-');
};

/** `usage_usec` of a cgroup v2 `cpu.stat`, in seconds. */
export const usageOf = (cpuStat: string): number | undefined => {
    const usec = /^usage_usec (\d+)$/m.exec(cpuStat)?.[1];
    return usec === undefined ? undefined : Number(usec) / 1e6;
};

/** Whether a cgroup v2 `cgroup.events` says a process is in it (or below it). */
export const isPopulated = (cgroupEvents: string): boolean => /^populated 1$/m.test(cgroupEvents);

/**
 * A reading: totals only grow. An empty cgroup ends the pod only after it
 * ran: when the kubelet creates a pod's cgroup it is empty for a moment,
 * and taking that as the end froze every short run at 0 (dev cluster,
 * 2026-11-15).
 */
export function observe(totals: Totals, uid: string, seconds: number, now: number, populated: boolean): Totals {
    const seen = totals.get(uid);
    if (seen?.endedAt !== undefined) {
        return totals;
    }
    const ran = seen?.ran === true || populated;
    return new Map(totals).set(uid, {
        ...seen,
        seconds: Math.max(seen?.seconds ?? 0, seconds),
        ...(ran ? { ran: true as const } : {}),
        ...(ran && !populated ? { endedAt: now } : {}),
    });
}

/** Pods whose cgroup is gone are ended with their last reading. */
export function endMissing(totals: Totals, present: ReadonlySet<string>, now: number): Totals {
    const missing = [...totals].filter(([uid, tracked]) => tracked.endedAt === undefined && !present.has(uid));
    return missing.length === 0 ? totals : new Map([...totals, ...missing.map(([uid, tracked]): [string, Tracked] => [uid, { ...tracked, endedAt: now }])]);
}

/** Names from the Kubernetes API, for the pods not named yet. */
export function name(totals: Totals, pods: ReadonlyMap<string, { readonly namespace: string; readonly pod: string }>): Totals {
    const named = [...totals].flatMap(([uid, tracked]): [string, Tracked][] => {
        const found = tracked.pod === undefined ? pods.get(uid) : undefined;
        return found === undefined ? [] : [[uid, { ...tracked, ...found }]];
    });
    return named.length === 0 ? totals : new Map([...totals, ...named]);
}

/** Drops pods that ended more than KEEP_MS ago. */
export const expire = (totals: Totals, now: number): Totals =>
    new Map([...totals].filter(([, tracked]) => tracked.endedAt === undefined || now - tracked.endedAt < KEEP_MS));

export const METRIC = 'openupstream_pod_cpu_usage_seconds_total';

const escape = (value: string): string => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/** The Prometheus text format, one series per named pod; the uid keeps a restarted pod of the same name apart. */
export function metricsText(totals: Totals): string {
    const lines = [...totals].flatMap(([uid, tracked]) =>
        tracked.pod === undefined || tracked.namespace === undefined
            ? []
            : [`${METRIC}{namespace="${escape(tracked.namespace)}",pod="${escape(tracked.pod)}",uid="${uid}"} ${tracked.seconds}`],
    );
    return [`# HELP ${METRIC} CPU seconds a pod used since it started, read from its cgroup; kept 15 minutes after it ended.`, `# TYPE ${METRIC} counter`, ...lines, ''].join('\n');
}
