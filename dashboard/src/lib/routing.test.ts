import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Domain } from '@openupstream/sdk';
import { NEW_ROUTE, bucketEndpoint, bucketNameProblem, hostnameOf, hostnameProblem, ingressOf, routeInput, servedAt, targetLabel, targetOptions } from './routing';

const targets = {
    buckets: [
        { id: 'b1', name: 'site' },
        { id: 'b2', name: 'files' },
    ],
    services: [
        { id: 's1', name: 'api', port: 8080 },
        { id: 's2', name: 'worker', port: null },
    ],
};

test('a Bucket name the API would take', () => {
    assert.equal(bucketNameProblem('acme-site', [{ name: 'other' }]), undefined);
    assert.equal(bucketNameProblem('', []), 'Enter a name.');
    assert.match(bucketNameProblem('ab', []) ?? '', /3 to 63/);
    assert.match(bucketNameProblem('Acme', []) ?? '', /Lowercase/);
    assert.match(bucketNameProblem('-acme', []) ?? '', /Lowercase/);
    assert.equal(bucketNameProblem('site', [{ name: 'site' }]), 'A Bucket named site exists.');
});

test('a hostname as pasted, and what is wrong with one', () => {
    assert.equal(hostnameOf('  https://WWW.Example.com/path?x '), 'www.example.com');
    assert.equal(hostnameOf('example.com.'), 'example.com');
    assert.equal(hostnameProblem('www.example.com', []), undefined);
    assert.equal(hostnameProblem('', []), 'Enter a hostname.');
    assert.match(hostnameProblem('localhost', []) ?? '', /at least one dot/);
    assert.match(hostnameProblem('a b.example.com', []) ?? '', /at least one dot/);
    assert.equal(hostnameProblem('www.example.com', [{ hostname: 'www.example.com' }]), 'This Project has www.example.com already.');
});

test('the customer domain is what follows the default Domain\'s first label', () => {
    assert.equal(ingressOf('test-k3j9x0ab.openupstream.app'), 'ingress.openupstream.app');
    assert.equal(bucketEndpoint('site', 'test-k3j9x0ab.home.dev.openupstream.app'), 'https://site.s3.home.dev.openupstream.app');
});

test('a Route goes to a Bucket, or to a Service that has a port', () => {
    assert.deepEqual(targetOptions(targets), [
        { value: 'bucket:b1', label: 'Bucket site' },
        { value: 'bucket:b2', label: 'Bucket files' },
        { value: 'service:s1', label: 'Service api' },
    ]);
    assert.deepEqual(routeInput({ pathPrefix: ' / ', target: 'bucket:b1', spaFallback: true }, [], targets, []), { pathPrefix: '/', bucketId: 'b1', spaFallback: true });
    assert.deepEqual(routeInput({ pathPrefix: '/api', target: 'service:s1', spaFallback: true }, [], targets, []), { pathPrefix: '/api', serviceId: 's1' });
});

test('what is wrong with a Route', () => {
    const routes = [{ pathPrefix: '/', target: { kind: 'bucket' as const, bucketId: 'b1', spaFallback: true } }];
    assert.equal(routeInput(NEW_ROUTE, [], targets, []), 'Choose what the Route goes to.');
    assert.equal(routeInput({ ...NEW_ROUTE, target: 'service:s2' }, [], targets, []), 'Choose what the Route goes to.');
    assert.equal(routeInput({ ...NEW_ROUTE, target: 'bucket:gone' }, [], targets, []), 'Choose what the Route goes to.');
    assert.match(String(routeInput({ ...NEW_ROUTE, pathPrefix: '/docs/', target: 'bucket:b1' }, [], targets, [])), /no slash at its end/);
    assert.match(String(routeInput({ ...NEW_ROUTE, pathPrefix: 'docs', target: 'bucket:b1' }, [], targets, [])), /starts with a slash/);
    assert.equal(routeInput({ ...NEW_ROUTE, target: 'bucket:b2' }, routes, targets, routes), 'This Domain has a Route at /. Delete it first.');
    assert.match(String(routeInput({ pathPrefix: '/old', target: 'bucket:b1', spaFallback: false }, routes, targets, routes)), /^Another Route \(\/\) serves this Bucket with the fallback/);
    // The other Route may be on another Domain: the path is free here, the fallback is the Bucket's all the same.
    assert.match(String(routeInput({ pathPrefix: '/', target: 'bucket:b1', spaFallback: false }, [], targets, routes)), /^Another Route \(\/\) serves this Bucket with the fallback/);
    assert.deepEqual(routeInput({ pathPrefix: '/old', target: 'bucket:b1', spaFallback: true }, routes, targets, routes), { pathPrefix: '/old', bucketId: 'b1', spaFallback: true });
});

test('what a Route goes to, in words', () => {
    assert.equal(targetLabel({ target: { kind: 'bucket', bucketId: 'b1', spaFallback: false } }, targets), 'Bucket site');
    assert.equal(targetLabel({ target: { kind: 'bucket', bucketId: 'b1', spaFallback: true } }, targets), 'Bucket site, paths without an object serve index.html');
    assert.equal(targetLabel({ target: { kind: 'service', serviceId: 's1' } }, targets), 'Service api');
    assert.equal(targetLabel({ target: { kind: 'service', serviceId: 'gone' } }, targets), 'Service (gone)');
});

test('a Resource is served where Routes of routed Domains go to it', () => {
    const base = { projectId: 'p', createdAt: '2026-11-17T00:00:00Z' };
    const domains: Domain[] = [
        { ...base, id: 'd1', kind: 'default', hostname: 'test-abc.openupstream.app' },
        { ...base, id: 'd2', kind: 'custom', hostname: 'www.example.com', verification: { state: 'verified', verifiedAt: '2026-11-17T00:00:00Z' } },
        { ...base, id: 'd3', kind: 'custom', hostname: 'new.example.com', verification: { state: 'pending', txtRecord: { name: '_openupstream.new.example.com', value: 'x' } } },
    ];
    const toSite = { kind: 'bucket' as const, bucketId: 'b1', spaFallback: false };
    const routes = {
        d1: [
            { pathPrefix: '/', target: toSite },
            { pathPrefix: '/api', target: { kind: 'service' as const, serviceId: 's1' } },
        ],
        d2: [{ pathPrefix: '/docs', target: toSite }],
        d3: [{ pathPrefix: '/', target: toSite }],
    };
    assert.deepEqual(servedAt('bucket', 'b1', domains, routes), ['https://test-abc.openupstream.app/', 'https://www.example.com/docs']);
    assert.deepEqual(servedAt('service', 's1', domains, routes), ['https://test-abc.openupstream.app/api']);
    assert.deepEqual(servedAt('bucket', 'b2', domains, routes), []);
});
