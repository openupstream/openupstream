/**
 * The CPU agent (ARCHITECTURE.md, "Metering and billing"; decision 113): one
 * per compute node (operators/deploy/cpu-agent.yaml). It reads every pod's
 * CPU total from its cgroup and serves it to Prometheus on /metrics, the
 * final total of a pod kept for 15 minutes after it ended. cAdvisor, which
 * Prometheus scrapes every 30 s, misses what a pod used after its last
 * scrape and all of a run shorter than that, because the kernel's total
 * goes with the cgroup within about half a second of the pod ending
 * (measured on the dev cluster, 2026-11-15).
 *
 * The total is read every second, at once when a pod's cgroup turns empty
 * (`cgroup.events`, inotify), and when a pod's cgroup appears, so even a
 * pod of a fraction of a second is counted.
 *
 * Environment:
 * - NODE_NAME: this node (the downward API), whose pods are listed for names
 * - CGROUP_ROOT: default /sys/fs/cgroup/kubepods.slice (the systemd driver)
 * - PORT: default 9101
 */
import { type FSWatcher, watch } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { CoreV1Api, KubeConfig } from '@kubernetes/client-node';
import { type Totals, endMissing, expire, isPopulated, metricsText, name, observe, podUidOf, usageOf } from './totals.js';

const log = (entry: Record<string, unknown>): void => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));

const node = process.env['NODE_NAME'] ?? '';
if (node === '') {
    log({ msg: 'NODE_NAME is not set' });
    process.exit(1);
}
const root = process.env['CGROUP_ROOT'] ?? '/sys/fs/cgroup/kubepods.slice';
const port = Number(process.env['PORT'] ?? 9101);
/** The pods' QoS classes: Guaranteed pods directly under the root, the others one level down. */
const parents = [root, join(root, 'kubepods-burstable.slice'), join(root, 'kubepods-besteffort.slice')];

let totals: Totals = new Map();
/** Pod slice directory by uid, and its cgroup.events watcher. */
const slices = new Map<string, { readonly dir: string; readonly watcher: FSWatcher | undefined }>();

const text = (path: string): Promise<string | undefined> => readFile(path, 'utf8').then((value) => value, () => undefined);

/** fs.watch, or undefined when the path is gone (a pod slice vanishing, a QoS class without pods): watch throws for that. */
const watchIfThere = (path: string, onChange: (entry: string | null) => void): FSWatcher | undefined => {
    const opened = ((): FSWatcher | undefined => {
        try {
            return watch(path, { persistent: false });
        } catch {
            return undefined;
        }
    })();
    opened?.on('change', (_event, entry) => onChange(typeof entry === 'string' ? entry : null));
    opened?.on('error', () => opened.close());
    return opened;
};

/** Reads one pod's total and whether a process is still in its cgroup. */
async function read(uid: string, dir: string): Promise<void> {
    const [cpuStat, events] = await Promise.all([text(join(dir, 'cpu.stat')), text(join(dir, 'cgroup.events'))]);
    const seconds = cpuStat === undefined ? undefined : usageOf(cpuStat);
    // Unreadable events (the cgroup going away): not a reason to end it; endMissing does that.
    if (seconds !== undefined) {
        totals = observe(totals, uid, seconds, Date.now(), events === undefined || isPopulated(events));
    }
}

/** Starts following a pod slice: a first reading and a watcher on its cgroup.events. */
function follow(uid: string, dir: string): void {
    if (slices.has(uid)) {
        return;
    }
    // inotify reports cgroup.events changing when the last process leaves.
    const watcher = watchIfThere(join(dir, 'cgroup.events'), () => void read(uid, dir));
    slices.set(uid, { dir, watcher });
    void read(uid, dir);
}

const listSlices = async (): Promise<[string, string][]> =>
    (
        await Promise.all(
            parents.map(async (parent) => {
                const entries = await readdir(parent).then((names) => names, () => [] as string[]);
                return entries.flatMap((entry): [string, string][] => {
                    const uid = podUidOf(entry);
                    return uid === undefined ? [] : [[uid, join(parent, entry)]];
                });
            }),
        )
    ).flat();

/** Every second: read every pod, follow new ones, end those whose cgroup is gone. */
async function scan(): Promise<void> {
    const found = await listSlices();
    for (const [uid, dir] of found) {
        follow(uid, dir);
    }
    await Promise.all(found.map(([uid, dir]) => read(uid, dir)));
    const present = new Set(found.map(([uid]) => uid));
    for (const [uid, slice] of slices) {
        if (!present.has(uid)) {
            slice.watcher?.close();
            slices.delete(uid);
        }
    }
    totals = expire(endMissing(totals, present, Date.now()), Date.now());
}

const kubeConfig = new KubeConfig();
kubeConfig.loadFromDefault();
const core = kubeConfig.makeApiClient(CoreV1Api);

/** Every 5 s: the names of this node's pods, for the uids not named yet. */
async function nameAll(): Promise<void> {
    const listed = await core.listPodForAllNamespaces({ fieldSelector: `spec.nodeName=${node}` }).then(
        (list) => list,
        (error: unknown) => {
            log({ msg: 'cannot list pods', error: error instanceof Error ? error.message : String(error) });
            return undefined;
        },
    );
    if (listed === undefined) {
        return;
    }
    const pods = new Map(
        listed.items.flatMap((pod): [string, { namespace: string; pod: string }][] =>
            pod.metadata?.uid === undefined || pod.metadata.name === undefined || pod.metadata.namespace === undefined
                ? []
                : [[pod.metadata.uid, { namespace: pod.metadata.namespace, pod: pod.metadata.name }]],
        ),
    );
    totals = name(totals, pods);
}

// A new pod slice is followed at once, not only at the next scan. A QoS
// class's directory appears with its first pod; the scan covers that.
for (const parent of parents) {
    watchIfThere(parent, (entry) => {
        const uid = entry === null ? undefined : podUidOf(entry);
        if (uid !== undefined && entry !== null) {
            follow(uid, join(parent, entry));
        }
    });
}

const every = (ms: number, task: () => Promise<void>): void => {
    const loop = (): void => void task().finally(() => setTimeout(loop, ms).unref());
    loop();
};
every(1_000, scan);
every(5_000, nameAll);

createServer((req, res) => {
    if (req.url === '/metrics') {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        res.end(metricsText(totals));
        return;
    }
    res.writeHead(req.url === '/healthz' ? 200 : 404);
    res.end();
}).listen(port, () => log({ msg: 'cpu agent listening', node, root, port }));
