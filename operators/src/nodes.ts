/**
 * The cluster's Nodes as the customer egress policies need them (decision
 * 105): every Node's addresses, which a Service's or Job's pod may reach on
 * 80 and 443 only. Pod traffic leaves with its node's address, so the host
 * firewall cannot tell it from the node-to-node traffic it admits; the
 * NetworkPolicy, enforced per pod, has to.
 *
 * Fails closed: no Nodes, a Node without an address, or a failed listing
 * is an error, and the pass that asked applies nothing, so the policies
 * already in place stay. The pass lists the Nodes itself every time; the
 * watch only starts it early when a Node joins or its addresses change.
 */
import { isIPv4, isIPv6 } from 'node:net';
import { CoreV1Api, type KubeConfig, type V1Node, Watch } from '@kubernetes/client-node';
import { KUBE_CALL_TIMEOUT_MS, type KubeError, attemptWithin } from './kube.js';
import { type Result, err, ok } from './result.js';

export interface NodeAddresses {
    readonly name: string;
    readonly addresses: readonly string[];
}

export type ListNodes = () => Promise<Result<NodeAddresses[], KubeError>>;

/** Every node address a pod could reach, as CIDRs: IPv4 as /32, IPv6 as /128, sorted so a plan is stable. */
export interface NodeBlocks {
    readonly v4: readonly string[];
    readonly v6: readonly string[];
}

/** k3s reports the address it was given as InternalIP and, with `--node-external-ip`, ExternalIP. */
const ADDRESS_TYPES: ReadonlySet<string> = new Set(['InternalIP', 'ExternalIP']);

export const addressesOf = (node: V1Node): NodeAddresses => ({
    name: node.metadata?.name ?? '',
    addresses: [
        ...new Set(
            (node.status?.addresses ?? []).filter((address) => ADDRESS_TYPES.has(address.type)).map((address) => address.address),
        ),
    ]
        .filter((address) => isIPv4(address) || isIPv6(address))
        .sort(),
});

/** The blocks of all Nodes, or why the egress policies cannot be planned from them. */
export function nodeBlocks(nodes: readonly NodeAddresses[]): Result<NodeBlocks, string> {
    if (nodes.length === 0) {
        // A transient empty list must not plan policies that exclude no node.
        return err('no Nodes listed');
    }
    const without = nodes.filter((node) => node.addresses.length === 0).map((node) => node.name);
    if (without.length > 0) {
        return err(`Nodes without an IP address: ${without.join(', ')}`);
    }
    const addresses = [...new Set(nodes.flatMap((node) => node.addresses))].sort();
    return ok({
        v4: addresses.filter((address) => isIPv4(address)).map((address) => `${address}/32`),
        v6: addresses.filter((address) => isIPv6(address)).map((address) => `${address}/128`),
    });
}

/** Lists the Nodes and turns them into blocks; any failure is the reason the pass does nothing. */
export async function readNodeBlocks(listNodes: ListNodes): Promise<Result<NodeBlocks, KubeError | string>> {
    const nodes = await listNodes();
    return nodes.ok ? nodeBlocks(nodes.value) : nodes;
}

export function listNodesFrom(config: KubeConfig, { timeoutMs = KUBE_CALL_TIMEOUT_MS } = {}): ListNodes {
    const api = config.makeApiClient(CoreV1Api);
    return async () => {
        const result = await attemptWithin(() => api.listNode(), timeoutMs);
        return result.ok ? ok(result.value.items.map(addressesOf)) : result;
    };
}

/**
 * Remembers each Node's addresses across watch events and reconnects, and
 * says whether an event changed them: a Node's status is updated every few
 * seconds, and a reconnect replays every Node as ADDED.
 */
export function nodeChanges(): (phase: string, node: NodeAddresses) => boolean {
    const known = new Map<string, string>();
    return (phase, node) => {
        if (phase === 'DELETED') {
            return known.delete(node.name);
        }
        if (phase !== 'ADDED' && phase !== 'MODIFIED') {
            return false;
        }
        const key = node.addresses.join(',');
        if (known.get(node.name) === key) {
            return false;
        }
        known.set(node.name, key);
        return true;
    };
}

/** Below the client's own 30 s request timeout, so the server ends each watch cleanly. */
const WATCH_SECONDS = 25;

/** What watchNodes needs of the client's Watch, so tests can stand in for it. */
export type NodeWatch = Pick<Watch, 'watch'>;

export interface WatchTiming {
    /** Before opening the next watch after the server closed one: never a tight loop, even when it closes at once. */
    readonly reopenMs: number;
    /** Before opening the next watch after an error. */
    readonly retryMs: number;
}

const WATCH_TIMING: WatchTiming = { reopenMs: 1_000, retryMs: 5_000 };

/**
 * Calls `onChange` when a Node joins, goes or changes its addresses, until
 * `signal` aborts. A watch that ends is opened again after a pause, longer
 * after an error. A missed event costs at most one interval: the pass lists
 * the Nodes itself.
 */
export function watchNodes(
    watch: NodeWatch,
    onChange: () => void,
    log: (entry: Record<string, unknown>) => void,
    signal: AbortSignal,
    { reopenMs, retryMs }: WatchTiming = WATCH_TIMING,
): void {
    const changed = nodeChanges();
    // The watch running now; one listener stops whichever it is.
    let current: AbortController | undefined;
    signal.addEventListener('abort', () => current?.abort(), { once: true });
    const start = async (): Promise<void> => {
        if (signal.aborted) {
            return;
        }
        const restart = (error: unknown): void => {
            if (signal.aborted) {
                return;
            }
            const failed = error !== null && error !== undefined;
            if (failed) {
                log({ msg: 'node watch failed, retrying', error: error instanceof Error ? error.message : String(error) });
            }
            setTimeout(() => void start(), failed ? retryMs : reopenMs).unref();
        };
        current = await watch
            .watch(
                '/api/v1/nodes',
                { timeoutSeconds: WATCH_SECONDS },
                (phase, node: V1Node) => {
                    if (changed(phase, addressesOf(node))) {
                        onChange();
                    }
                },
                restart,
            )
            .catch((error: unknown) => {
                restart(error);
                return undefined;
            });
        if (signal.aborted) {
            current?.abort();
        }
    };
    void start();
}

/** The Nodes as the Services and Jobs passes read them, and the watch that wakes those passes. */
export function nodesFor(config: KubeConfig, wake: () => void, log: (entry: Record<string, unknown>) => void, signal: AbortSignal): ListNodes {
    watchNodes(new Watch(config), wake, log, signal);
    return listNodesFrom(config);
}
