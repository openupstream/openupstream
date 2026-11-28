import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { NodeInfo, SiteProblem } from '@openupstream/sdk';
import { descriptionProblem, isAdmin, nodeRole, problemsByNode } from './nodes';

test("an admin is a user whose madAuth claims' roles include admin", () => {
    assert.equal(isAdmin({ roles: ['support', 'admin'] }), true);
    assert.equal(isAdmin({ roles: ['support'] }), false);
    assert.equal(isAdmin({ roles: 'admin' }), false);
    assert.equal(isAdmin(undefined), false);
});

const node = (compute: boolean, quorumOnly: boolean): NodeInfo => ({
    name: 'n',
    site: 'home',
    compute,
    default: false,
    quorumOnly,
    ready: true,
    createdAt: '2026-11-28T00:00:00Z',
});

test("a node's role follows its compute label and its taint", () => {
    assert.equal(nodeRole(node(true, false)), 'compute');
    assert.equal(nodeRole(node(false, true)), 'quorum-only');
    assert.equal(nodeRole(node(false, false)), 'none');
    assert.equal(nodeRole(node(true, true)), 'compute and quorum-only');
});

test('problems go to their node; those about a Site or the cluster stay general', () => {
    const problem = (kind: SiteProblem['kind'], nodeName: string | null): SiteProblem => ({ kind, node: nodeName, site: null, message: '', fix: '' });
    const { byNode, general } = problemsByNode([
        problem('node-without-site', 'x'),
        problem('node-neither-compute-nor-quorum', 'x'),
        problem('default-site-missing', null),
    ]);
    assert.deepEqual(byNode.get('x')?.map((each) => each.kind), ['node-without-site', 'node-neither-compute-nor-quorum']);
    assert.equal(byNode.get('y'), undefined);
    assert.deepEqual(general.map((each) => each.kind), ['default-site-missing']);
});

test('a description may be empty (removes it) and at most 100 characters once trimmed', () => {
    assert.equal(descriptionProblem(''), undefined);
    assert.equal(descriptionProblem(`  ${'x'.repeat(100)}  `), undefined);
    assert.equal(descriptionProblem('x'.repeat(101)), 'At most 100 characters.');
});
