/** Nodes for the operators' tests: two compute nodes and the third Site's, one with an IPv6 address. */
import type { ListNodes, NodeAddresses, NodeBlocks } from '../nodes.js';
import { ok } from '../result.js';

export const NODES: readonly NodeAddresses[] = [
    { name: 'fsn1', addresses: ['198.51.100.1'] },
    { name: 'lim', addresses: ['203.0.113.2', '2001:db8::2'] },
    { name: 'nbg', addresses: ['192.0.2.3'] },
];

export const NODE_BLOCKS: NodeBlocks = {
    v4: ['192.0.2.3/32', '198.51.100.1/32', '203.0.113.2/32'],
    v6: ['2001:db8::2/128'],
};

export const listNodes: ListNodes = async () => ok([...NODES]);
