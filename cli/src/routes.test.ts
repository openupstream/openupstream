import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Domain, Route } from '@openupstream/sdk';
import { dnsRecords, domainNamed, formatDomains, formatRoutes, hostnameOf, hostnameProblem, ingressOf, parseAddress, routeInput } from './routes.js';

const base = { projectId: 'p', createdAt: '2026-11-17T00:00:00Z' };
const byDefault: Domain = { ...base, id: 'd1', kind: 'default', hostname: 'shop-k3j9x0ab.openupstream.app' };
const verified: Domain = { ...base, id: 'd2', kind: 'custom', hostname: 'www.example.com', verification: { state: 'verified', verifiedAt: '2026-11-17T00:00:00Z' } };
const pending: Domain = { ...base, id: 'd3', kind: 'custom', hostname: 'new.example.com', verification: { state: 'pending', txtRecord: { name: '_openupstream.new.example.com', value: 'tok' } } };
const domains = [byDefault, verified, pending];
const buckets = [{ id: 'b1', name: 'site' }];
const services = [
    { id: 's1', name: 'api', port: 8080 },
    { id: 's2', name: 'worker', port: null },
];

test('a hostname as pasted, and what is not one', () => {
    assert.equal(hostnameOf(' https://WWW.Example.com/docs '), 'www.example.com');
    assert.equal(hostnameOf('example.com.'), 'example.com');
    assert.equal(hostnameProblem('www.example.com'), undefined);
    assert.match(hostnameProblem('localhost') ?? '', /localhost is not a hostname/);
    assert.match(hostnameProblem('') ?? '', /that is not a hostname/);
});

test('an address names a Domain of the Project and a path; a path alone means the default Domain', () => {
    assert.deepEqual(parseAddress('www.example.com/docs', domains, 'shop'), { ok: true, value: { domain: verified, pathPrefix: '/docs' } });
    assert.deepEqual(parseAddress('https://WWW.example.com', domains, 'shop'), { ok: true, value: { domain: verified, pathPrefix: '/' } });
    assert.deepEqual(parseAddress('www.example.com/', domains, 'shop'), { ok: true, value: { domain: verified, pathPrefix: '/' } });
    assert.deepEqual(parseAddress('/api/v1', domains, 'shop'), { ok: true, value: { domain: byDefault, pathPrefix: '/api/v1' } });
    assert.deepEqual(parseAddress('/', domains, 'shop'), { ok: true, value: { domain: byDefault, pathPrefix: '/' } });
});

test('an address that names no Domain, or no path of a Route, says so', () => {
    const unknown = parseAddress('other.example.com/docs', domains, 'shop');
    assert.ok(!unknown.ok && /no Domain other\.example\.com in shop/.test(unknown.error));
    const trailing = parseAddress('www.example.com/docs/', domains, 'shop');
    assert.ok(!trailing.ok && /\/docs\/ is not a path of a Route/.test(trailing.error));
    const query = parseAddress('/docs?x=1', domains, 'shop');
    assert.ok(!query.ok);
    const none = parseAddress('/docs', [verified], 'shop');
    assert.ok(!none.ok && /no default Domain/.test(none.error));
    assert.deepEqual(domainNamed(domains, 'new.example.com', 'shop'), { ok: true, value: pending });
});

test('a Route goes to a Bucket or to a Service with a port, one of the two', () => {
    assert.deepEqual(routeInput('/', { bucket: 'site' }, buckets, services, 'shop'), { ok: true, value: { pathPrefix: '/', bucketId: 'b1', spaFallback: false } });
    assert.deepEqual(routeInput('/', { bucket: 'site', spa: true }, buckets, services, 'shop'), { ok: true, value: { pathPrefix: '/', bucketId: 'b1', spaFallback: true } });
    assert.deepEqual(routeInput('/api', { service: 'api' }, buckets, services, 'shop'), { ok: true, value: { pathPrefix: '/api', serviceId: 's1' } });
    const fails = (flags: Parameters<typeof routeInput>[1], pattern: RegExp) => {
        const result = routeInput('/', flags, buckets, services, 'shop');
        assert.ok(!result.ok && pattern.test(result.error), result.ok ? 'ok' : result.error);
    };
    fails({}, /--bucket <name> or --service <name>/);
    fails({ bucket: 'site', service: 'api' }, /--bucket <name> or --service <name>/);
    fails({ bucket: 'nope' }, /no Bucket nope in shop/);
    fails({ service: 'nope' }, /no Service nope in shop/);
    fails({ service: 'worker' }, /has no port/);
    fails({ service: 'api', spa: true }, /--spa is for a Bucket/);
});

test('Domains with their state, and the DNS records of one that is not verified', () => {
    assert.deepEqual(
        formatDomains(domains).map((line) => line.replace(/ +/g, ' ')),
        ['shop-k3j9x0ab.openupstream.app default', 'www.example.com verified', 'new.example.com not verified'],
    );
    assert.equal(ingressOf(domains), 'ingress.openupstream.app');
    assert.equal(ingressOf([verified]), undefined);
    assert.deepEqual(dnsRecords(pending, 'ingress.openupstream.app'), ['TXT    _openupstream.new.example.com   tok', 'CNAME  new.example.com   ingress.openupstream.app']);
    assert.deepEqual(dnsRecords(pending, undefined), ['TXT    _openupstream.new.example.com   tok']);
    assert.deepEqual(dnsRecords(verified, 'ingress.openupstream.app'), []);
    assert.deepEqual(dnsRecords(byDefault, 'ingress.openupstream.app'), []);
});

test('Routes by address with what they go to', () => {
    const route = (id: string, pathPrefix: string, to: Route['target']): Route => ({ id, domainId: 'd', pathPrefix, target: to, createdAt: base.createdAt });
    const routes = {
        d1: [route('r1', '/', { kind: 'bucket', bucketId: 'b1', spaFallback: true }), route('r2', '/api', { kind: 'service', serviceId: 's1' })],
        d3: [route('r3', '/', { kind: 'bucket', bucketId: 'gone', spaFallback: false })],
    };
    assert.deepEqual(
        formatRoutes(domains, routes, buckets, services).map((line) => line.replace(/ +/g, ' ')),
        ['shop-k3j9x0ab.openupstream.app/ Bucket site (single-page app)', 'shop-k3j9x0ab.openupstream.app/api Service api', 'new.example.com/ Bucket (gone) (Domain not verified)'],
    );
});
