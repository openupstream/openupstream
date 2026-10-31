import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DomainRouting } from '@openupstream/sdk';
import { matchOf, planRoutes } from './manifests.js';

const routing: DomainRouting = {
    projectId: '11111111-1111-4111-8111-111111111111',
    projectName: 'shop',
    domainId: '22222222-2222-4222-8222-222222222222',
    hostname: 'shop-a1b2c3d4.openupstream.app',
    routes: [
        { id: '33333333-3333-4333-8333-333333333333', pathPrefix: '/docs', bucketName: 'shop-docs', spaFallback: false },
        { id: '44444444-4444-4444-8444-444444444444', pathPrefix: '/', bucketName: 'shop-site', spaFallback: true },
    ],
};
const namespace = 'project-11111111-1111-4111-8111-111111111111';

test('a prefix matches itself and what is below it, not a longer segment', () => {
    assert.equal(matchOf('a.test', '/'), 'Host(`a.test`)');
    assert.equal(matchOf('a.test', '/docs'), 'Host(`a.test`) && (Path(`/docs`) || PathPrefix(`/docs/`))');
});

test("a Project's namespace, Garage's website endpoint and the shared Middlewares, then each Route's, then the IngressRoute", () => {
    const plan = planRoutes([routing]);
    assert.deepEqual(
        plan.map((o) => `${o.kind} ${o.metadata.name}`),
        [
            `Namespace ${namespace}`,
            'Service garage-web',
            'Middleware compress',
            'Middleware hsts',
            'Middleware route-33333333-3333-4333-8333-333333333333-bucket',
            'Middleware route-33333333-3333-4333-8333-333333333333-strip',
            'Middleware route-44444444-4444-4444-8444-444444444444-bucket',
            'IngressRoute domain-22222222-2222-4222-8222-222222222222',
        ],
    );
    assert.ok(plan.slice(1).every((o) => o.metadata.namespace === namespace && o.metadata.labels?.['openupstream.io/component'] === 'routes'));
    assert.deepEqual(plan[1]?.['spec'], {
        type: 'ExternalName',
        externalName: 'garage.garage.svc.cluster.local',
        ports: [{ name: 'web', port: 3902 }],
    });
    assert.deepEqual(plan[4]?.['spec'], { headers: { customRequestHeaders: { Host: 'shop-docs' } } });
    assert.deepEqual(plan[5]?.['spec'], { stripPrefix: { prefixes: ['/docs'] } });
});

test('the IngressRoute sends each prefix to Garage with its Middlewares, on the default certificate', () => {
    const ingress = planRoutes([routing]).at(-1);
    assert.deepEqual(ingress?.['spec'], {
        entryPoints: ['websecure'],
        routes: [
            {
                match: 'Host(`shop-a1b2c3d4.openupstream.app`) && (Path(`/docs`) || PathPrefix(`/docs/`))',
                kind: 'Rule',
                middlewares: [
                    { name: 'hsts' },
                    { name: 'compress' },
                    { name: 'route-33333333-3333-4333-8333-333333333333-strip' },
                    { name: 'route-33333333-3333-4333-8333-333333333333-bucket' },
                ],
                services: [{ name: 'garage-web', port: 3902 }],
            },
            {
                match: 'Host(`shop-a1b2c3d4.openupstream.app`)',
                kind: 'Rule',
                middlewares: [{ name: 'hsts' }, { name: 'compress' }, { name: 'route-44444444-4444-4444-8444-444444444444-bucket' }],
                services: [{ name: 'garage-web', port: 3902 }],
            },
        ],
        tls: {},
    });
});

test('two Domains of one Project share its objects', () => {
    const second = { ...routing, domainId: '55555555-5555-4555-8555-555555555555', routes: [] };
    const kinds = planRoutes([routing, second]).map((o) => `${o.kind} ${o.metadata.name}`);
    assert.equal(kinds.filter((k) => k === 'Service garage-web').length, 1);
    assert.equal(kinds.filter((k) => k.startsWith('IngressRoute')).length, 2);
});
