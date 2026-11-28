import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type NodeLabels, chooseSite, described, nodesReport, siteMetrics, siteProblems, siteReader, sitesOf } from './sites.js';
import { err, ok } from './result.js';

const node = (name: string, site: string | undefined, extra: Partial<NodeLabels> = {}): NodeLabels => ({
    name,
    site,
    compute: true,
    default: false,
    createdAt: '2026-11-01T00:00:00Z',
    quorumOnly: false,
    ready: true,
    ...extra,
});

test('the compute Sites are the zones of the compute nodes, by id, without the others', () => {
    const sites = sitesOf([
        node('c', 'ovh-lim'),
        node('a', 'hetzner-fsn1', { default: true }),
        node('b', 'hetzner-fsn1'),
        node('w', 'netcup-nbg', { compute: false }),
        node('x', undefined),
    ]);
    assert.deepEqual(sites.list, [
        { id: 'hetzner-fsn1', description: null, default: true },
        { id: 'ovh-lim', description: null, default: false },
    ]);
    assert.equal(sites.default, 'hetzner-fsn1');
    assert.deepEqual([...sites.nodes], [
        ['c', 'ovh-lim'],
        ['a', 'hetzner-fsn1'],
        ['b', 'hetzner-fsn1'],
    ]);
});

test('without a default label, or with several, the first by id is the default', () => {
    assert.equal(sitesOf([node('a', 'zeta'), node('b', 'alpha')]).default, 'alpha');
    assert.equal(sitesOf([node('a', 'zeta', { default: true }), node('b', 'beta', { default: true }), node('c', 'alpha')]).default, 'beta');
    assert.equal(sitesOf([node('w', 'netcup-nbg', { compute: false })]).default, undefined);
});

test("the nodes give no description; described adds the stored ones, null for the rest", () => {
    const sites = sitesOf([node('a', 'home-a'), node('b', 'home-b')]);
    assert.deepEqual(sites.list.map((site) => site.description), [null, null]);
    assert.deepEqual(
        described(sites.list, new Map([['home-b', 'Office rack']])).map((site) => [site.id, site.description]),
        [
            ['home-a', null],
            ['home-b', 'Office rack'],
        ],
    );
});

test('a Site is chosen when it is a compute Site, the default when none is given', () => {
    const sites = sitesOf([node('a', 'home-a', { default: true }), node('b', 'home-b')]);
    assert.deepEqual(chooseSite(sites, undefined), ok('home-a'));
    assert.deepEqual(chooseSite(sites, 'home-b'), ok('home-b'));
    assert.deepEqual(chooseSite(sites, 'hetzner-fsn1'), err({ kind: 'unknown', site: 'hetzner-fsn1', sites: ['home-a', 'home-b'] }));
    assert.deepEqual(chooseSite(sitesOf([]), undefined), err({ kind: 'none' }));
});

test('the node list is read again after the TTL; a failed read is logged and keeps the last list for another TTL', async () => {
    let clock = 0;
    const answers = [ok([node('a', 'one')]), err('down'), ok([node('a', 'two')])];
    let calls = 0;
    const logged: Record<string, unknown>[] = [];
    const read = siteReader(async () => answers[calls++] ?? err('none left'), 1000, () => clock, (entry) => logged.push(entry));
    assert.deepEqual((await read()).ok && (await read()).ok, true);
    assert.equal(calls, 1, 'cached within the TTL');
    clock = 1000;
    const stale = await read();
    assert.ok(stale.ok && stale.value.default === 'one' && stale.value.readAt === 0, 'the failed read keeps the last list and its time');
    assert.equal(logged[0]?.['error'], 'down');
    clock = 1500;
    assert.ok((await read()).ok);
    assert.equal(calls, 2, 'not asked again within the TTL after a failure');
    clock = 2000;
    const fresh = await read();
    assert.ok(fresh.ok && fresh.value.default === 'two' && fresh.value.readAt === 2000);
    assert.equal(calls, 3);
});

test('without any list read, a failure is returned', async () => {
    const read = siteReader(async () => err('forbidden'));
    assert.deepEqual(await read(), err('forbidden'));
});

/** Two compute Sites, the first the default, and a quorum-only one: all well. */
const healthy = [
    node('a1', 'home-a', { default: true }),
    node('a2', 'home-a', { default: true }),
    node('b1', 'home-b'),
    node('q1', 'quorum', { compute: false, quorumOnly: true }),
];
const kinds = (nodes: NodeLabels[]) => siteProblems(nodes).map((problem) => [problem.kind, problem.node ?? problem.site]);

test('a layout as the install wants it has no problems, nor has a single node labelled compute and default', () => {
    assert.deepEqual(siteProblems(healthy), []);
    assert.deepEqual(siteProblems([node('only', 'home', { default: true })]), []);
});

test('a node is caught without a Site, without a role, or with both roles', () => {
    assert.deepEqual(kinds([...healthy, node('x', undefined, { compute: false })]), [
        ['node-without-site', 'x'],
        ['node-neither-compute-nor-quorum', 'x'],
    ]);
    assert.deepEqual(kinds([...healthy, node('q2', 'quorum', { compute: false })]), [['node-neither-compute-nor-quorum', 'q2']]);
    assert.deepEqual(kinds([...healthy, node('b2', 'home-b', { quorumOnly: true })]), [['node-compute-and-quorum', 'b2']]);
});

test('the nodes of a Site must agree on the compute and the default label', () => {
    assert.deepEqual(kinds([...healthy, node('q2', 'quorum')]), [['site-mixed-compute', 'quorum']]);
    assert.deepEqual(kinds([...healthy, node('a3', 'home-a')]), [['site-mixed-default', 'home-a']]);
});

test('exactly one default Site, and a compute one', () => {
    const undefaulted = healthy.map((each) => ({ ...each, default: false }));
    const missing = siteProblems(undefaulted);
    assert.deepEqual(missing.map((problem) => problem.kind), ['default-site-missing']);
    assert.match(missing[0]?.fix ?? '', /zone=home-a openupstream\.io\/default-site=true$/);
    assert.deepEqual(kinds(healthy.map((each) => (each.site === 'home-b' ? { ...each, default: true } : each))), [['default-site-not-unique', null]]);
    assert.deepEqual(kinds([...undefaulted.slice(0, 3), node('q1', 'quorum', { compute: false, quorumOnly: true, default: true })]), [
        ['default-site-not-compute', 'quorum'],
    ]);
});

test('more than one node needs two compute Sites and three Sites', () => {
    assert.deepEqual(kinds(healthy.filter((each) => each.site !== 'home-b')), [
        ['compute-sites-below-two', null],
        ['sites-below-three', null],
    ]);
    assert.deepEqual(kinds([node('a1', 'home-a', { default: true }), node('b1', 'home-b')]), [['sites-below-three', null]]);
    // A stray node without a Site on a single-node install is that one problem, not a layout.
    assert.deepEqual(kinds([node('only', 'home', { default: true }), node('x', undefined, { compute: false, quorumOnly: true })]), [['node-without-site', 'x']]);
});

test('the report lists every node by Site, those without one first', () => {
    const report = nodesReport(
        [node('b1', 'home-b'), node('x', undefined), node('a1', 'home-a', { default: true }), node('q1', 'quorum', { compute: false, quorumOnly: true })],
        new Map([['home-b', 'B']]),
    );
    assert.deepEqual(
        report.nodes.map((each) => [each.name, each.site]),
        [
            ['x', null],
            ['a1', 'home-a'],
            ['b1', 'home-b'],
            ['q1', 'quorum'],
        ],
    );
    assert.deepEqual(report.sites, [
        { id: 'home-a', description: null, default: true, compute: true },
        { id: 'home-b', description: 'B', default: false, compute: true },
        { id: 'quorum', description: null, default: false, compute: false },
    ]);
    assert.deepEqual(report.problems.map((problem) => problem.kind), ['node-without-site']);
});

test('the metrics hold one series per problem and the node count; nothing without a node list', () => {
    const text = siteMetrics({ all: [...healthy, node('x', undefined, { compute: false, quorumOnly: true })], readAt: 1_700_000_000_000 });
    assert.match(text, /^openupstream_site_problem\{problem="node-without-site",node="x",site=""\} 1$/m);
    assert.match(text, /^openupstream_site_nodes 5$/m);
    assert.match(text, /^openupstream_site_nodes_read_timestamp_seconds 1700000000$/m);
    assert.equal(text.match(/^openupstream_site_problem\{/gm)?.length, 1);
    const blind = siteMetrics(undefined);
    assert.doesNotMatch(blind, /^openupstream_site_(problem|nodes|nodes_read_timestamp_seconds)[ {]/m);
    assert.match(blind, /# TYPE openupstream_site_nodes gauge/);
});
