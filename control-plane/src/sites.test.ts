import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type NodeLabels, chooseSite, siteReader, sitesOf } from './sites.js';
import { err, ok } from './result.js';

const node = (name: string, site: string | undefined, extra: Partial<NodeLabels> = {}): NodeLabels => ({
    name,
    site,
    compute: true,
    default: false,
    description: undefined,
    createdAt: '2026-11-01T00:00:00Z',
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

test("a Site's description is its oldest node's that has one", () => {
    const sites = sitesOf([
        node('new', 'home-a', { description: 'Newer', createdAt: '2026-11-20T00:00:00Z' }),
        node('old', 'home-a', { description: '  Home VM A ', createdAt: '2026-11-02T00:00:00Z' }),
        node('oldest', 'home-a', { description: ' ', createdAt: '2026-11-01T00:00:00Z' }),
    ]);
    assert.equal(sites.list[0]?.description, 'Home VM A');
});

test('a Site is chosen when it is a compute Site, the default when none is given', () => {
    const sites = sitesOf([node('a', 'home-a', { default: true }), node('b', 'home-b')]);
    assert.deepEqual(chooseSite(sites, undefined), ok('home-a'));
    assert.deepEqual(chooseSite(sites, 'home-b'), ok('home-b'));
    assert.deepEqual(chooseSite(sites, 'hetzner-fsn1'), err({ kind: 'unknown', site: 'hetzner-fsn1', sites: ['home-a', 'home-b'] }));
    assert.deepEqual(chooseSite(sitesOf([]), undefined), err({ kind: 'none' }));
});

test('the node list is read again after the TTL, and the last list stays when reading fails', async () => {
    let clock = 0;
    const answers = [ok([node('a', 'one')]), err('down'), ok([node('a', 'two')])];
    let calls = 0;
    const read = siteReader(async () => answers[calls++] ?? err('none left'), 1000, () => clock);
    assert.deepEqual((await read()).ok && (await read()).ok, true);
    assert.equal(calls, 1, 'cached within the TTL');
    clock = 1000;
    const stale = await read();
    assert.ok(stale.ok && stale.value.default === 'one', 'the failed read keeps the last list');
    const fresh = await read();
    assert.ok(fresh.ok && fresh.value.default === 'two');
    assert.equal(calls, 3);
});

test('without any list read, a failure is returned', async () => {
    const read = siteReader(async () => err('forbidden'));
    assert.deepEqual(await read(), err('forbidden'));
});
