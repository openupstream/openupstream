import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { DomainRouting, RoutedPath } from '@openupstream/sdk';
import { COMPONENT_LABEL, PRUNED_KINDS, matchOf, planRoutes, priorityOf } from './manifests.js';

const routing: DomainRouting = {
    projectId: '11111111-1111-4111-8111-111111111111',
    projectName: 'shop',
    domainId: '22222222-2222-4222-8222-222222222222',
    hostname: 'shop-a1b2c3d4.openupstream.app',
    kind: 'default',
    routes: [
        { id: '33333333-3333-4333-8333-333333333333', pathPrefix: '/docs', kind: 'bucket', bucketId: '66666666-6666-4666-8666-666666666666', bucketName: 'shop-docs', spaFallback: false },
        { id: '44444444-4444-4444-8444-444444444444', pathPrefix: '/', kind: 'bucket', bucketId: '77777777-7777-4777-8777-777777777777', bucketName: 'shop-site', spaFallback: true },
    ],
};
const namespace = 'project-11111111-1111-4111-8111-111111111111';
const settings = { clusterIssuer: 'letsencrypt-staging' };

test('a prefix matches itself and what is below it, not a longer segment', () => {
    assert.equal(matchOf('a.test', '/'), 'Host(`a.test`)');
    assert.equal(matchOf('a.test', '/docs'), 'Host(`a.test`) && (Path(`/docs`) || PathPrefix(`/docs/`))');
});

test("a Project's namespace and NetworkPolicy, Garage's website endpoint and the shared Middlewares, then each Route's, then an IngressRoute per Resource", () => {
    const plan = planRoutes([routing], settings);
    assert.deepEqual(
        plan.map((o) => `${o.kind} ${o.metadata.name}`),
        [
            `Namespace ${namespace}`,
            'NetworkPolicy project-isolation',
            'Service garage-web',
            'Middleware compress',
            'Middleware hsts',
            'Middleware route-33333333-3333-4333-8333-333333333333-bucket',
            'Middleware route-33333333-3333-4333-8333-333333333333-strip',
            'Middleware route-44444444-4444-4444-8444-444444444444-bucket',
            'IngressRoute domain-22222222-2222-4222-8222-222222222222-bucket-66666666-6666-4666-8666-666666666666',
            'IngressRoute domain-22222222-2222-4222-8222-222222222222-bucket-77777777-7777-4777-8777-777777777777',
        ],
    );
    assert.ok(plan.slice(2).every((o) => o.metadata.namespace === namespace && o.metadata.labels?.['openupstream.io/component'] === 'routes'));
    assert.deepEqual(plan[2]?.['spec'], {
        type: 'ExternalName',
        externalName: 'garage.garage.svc.cluster.local',
        ports: [{ name: 'web', port: 3902 }],
    });
    assert.deepEqual(plan[5]?.['spec'], { headers: { customRequestHeaders: { Host: 'shop-docs' } } });
    assert.deepEqual(plan[6]?.['spec'], { stripPrefix: { prefixes: ['/docs'] } });
});

test("each Resource's IngressRoute sends its prefix to Garage with its Middlewares, on the default certificate", () => {
    const ingress = planRoutes([routing], settings).filter((o) => o.kind === 'IngressRoute');
    assert.deepEqual(
        ingress.map((o) => o['spec']),
        [
            {
                entryPoints: ['websecure'],
                routes: [
                    {
                        match: 'Host(`shop-a1b2c3d4.openupstream.app`) && (Path(`/docs`) || PathPrefix(`/docs/`))',
                        kind: 'Rule',
                        priority: 1010,
                        middlewares: [
                            { name: 'hsts' },
                            { name: 'compress' },
                            { name: 'route-33333333-3333-4333-8333-333333333333-strip' },
                            { name: 'route-33333333-3333-4333-8333-333333333333-bucket' },
                        ],
                        services: [{ name: 'garage-web', port: 3902 }],
                    },
                ],
                tls: {},
            },
            {
                entryPoints: ['websecure'],
                routes: [
                    {
                        match: 'Host(`shop-a1b2c3d4.openupstream.app`)',
                        kind: 'Rule',
                        priority: 1000,
                        middlewares: [{ name: 'hsts' }, { name: 'compress' }, { name: 'route-44444444-4444-4444-8444-444444444444-bucket' }],
                        services: [{ name: 'garage-web', port: 3902 }],
                    },
                ],
                tls: {},
            },
        ],
    );
});

test('two Routes to one Resource share its IngressRoute', () => {
    const site = routing.routes[1] as RoutedPath;
    const twice: DomainRouting = { ...routing, routes: [site, { ...site, id: '88888888-8888-4888-8888-888888888888', pathPrefix: '/app' }] };
    const ingress = planRoutes([twice], settings).filter((o) => o.kind === 'IngressRoute');
    assert.equal(ingress.length, 1);
    assert.equal((ingress[0]?.['spec'] as { routes: unknown[] }).routes.length, 2);
});

test('two Domains of one Project share its objects', () => {
    const second = { ...routing, domainId: '55555555-5555-4555-8555-555555555555', routes: [] };
    const kinds = planRoutes([routing, second], settings).map((o) => `${o.kind} ${o.metadata.name}`);
    assert.equal(kinds.filter((k) => k === 'Service garage-web').length, 1);
    assert.equal(kinds.filter((k) => k.startsWith('IngressRoute')).length, 2);
});

test('a custom domain gets a Certificate of its own through the ClusterIssuer, before its IngressRoute uses it', () => {
    const custom: DomainRouting = { ...routing, hostname: 'www.shop.example', kind: 'custom' };
    const plan = planRoutes([custom], settings);
    const certificate = plan.find((o) => o.kind === 'Certificate');
    const ingresses = plan.filter((o) => o.kind === 'IngressRoute');
    assert.ok(plan.indexOf(certificate ?? plan[0]!) < plan.indexOf(ingresses[0] ?? plan[0]!), 'the Certificate before the IngressRoutes using it');
    assert.equal(certificate?.kind, 'Certificate');
    assert.equal(certificate?.metadata.name, 'domain-22222222-2222-4222-8222-222222222222');
    // The label is how the ClusterIssuer picks its HTTP-01 solver (infra/ingress/cluster-issuers.yaml).
    assert.equal(certificate?.metadata.labels?.['openupstream.io/component'], 'routes');
    assert.deepEqual(certificate?.['spec'], {
        secretName: 'domain-22222222-2222-4222-8222-222222222222-tls',
        issuerRef: { kind: 'ClusterIssuer', name: 'letsencrypt-staging' },
        dnsNames: ['www.shop.example'],
        privateKey: { algorithm: 'ECDSA', size: 256, rotationPolicy: 'Always' },
    });
    assert.equal(ingresses.length, 2);
    for (const ingress of ingresses) {
        assert.deepEqual((ingress['spec'] as { tls: unknown }).tls, { secretName: 'domain-22222222-2222-4222-8222-222222222222-tls' }, 'each names the one certificate');
    }
    assert.ok(!planRoutes([routing], settings).some((o) => o.kind === 'Certificate'));
});

test("the namespace and its NetworkPolicy are never pruned: a Project's last Route going must not lift its isolation", () => {
    const shared = planRoutes([routing], settings).slice(0, 2);
    assert.deepEqual(shared.map((o) => o.kind), ['Namespace', 'NetworkPolicy']);
    assert.ok(shared.every((o) => o.metadata.labels?.[COMPONENT_LABEL] === undefined));
    assert.ok(PRUNED_KINDS.every(({ kind }) => !shared.some((o) => o.kind === kind)));
});

test('a Route to a Service: its Kubernetes Service, path unchanged, GET and HEAD retried on another pod, the rest never', () => {
    const withService: DomainRouting = {
        ...routing,
        routes: [
            { id: '66666666-6666-4666-8666-666666666666', pathPrefix: '/api', kind: 'service', serviceId: '77777777-7777-4777-8777-777777777777', port: 8080 },
            ...routing.routes,
        ],
    };
    const plan = planRoutes([withService], settings);
    const names = plan.map((o) => `${o.kind} ${o.metadata.name}`);
    assert.ok(names.includes('ServersTransport fail-fast'));
    assert.ok(names.includes('Middleware retry-other-pod'));
    assert.ok(!names.some((name) => name.startsWith('Middleware route-66666666')), 'no strip or host Middleware for a Service');
    const serviceIngress = plan.find((o) => o.metadata.name === 'domain-22222222-2222-4222-8222-222222222222-svc-77777777-7777-4777-8777-777777777777');
    const rules = (serviceIngress?.['spec'] as { routes: { match: string; priority: number; middlewares: { name: string }[]; services: unknown[] }[] }).routes;
    const service = [{ name: 'svc-77777777-7777-4777-8777-777777777777', port: 8080, serversTransport: 'fail-fast' }];
    assert.deepEqual(rules.slice(0, 2), [
        {
            match: 'Host(`shop-a1b2c3d4.openupstream.app`) && (Path(`/api`) || PathPrefix(`/api/`)) && (Method(`GET`) || Method(`HEAD`))',
            kind: 'Rule',
            priority: 1009,
            middlewares: [{ name: 'hsts' }, { name: 'compress' }, { name: 'retry-other-pod' }],
            services: service,
        },
        {
            match: 'Host(`shop-a1b2c3d4.openupstream.app`) && (Path(`/api`) || PathPrefix(`/api/`))',
            kind: 'Rule',
            priority: 1008,
            middlewares: [{ name: 'hsts' }, { name: 'compress' }],
            services: service,
        },
    ]);
    // The longer prefix wins over `/` whatever the method, also across IngressRoutes: Traefik ranks all rules by priority.
    const siteIngress = plan.find((o) => o.metadata.name === 'domain-22222222-2222-4222-8222-222222222222-bucket-77777777-7777-4777-8777-777777777777');
    const rootPriority = (siteIngress?.['spec'] as { routes: { priority: number }[] }).routes[0]?.priority ?? Infinity;
    assert.ok(rules.slice(0, 2).every((rule) => rule.priority > rootPriority));
    assert.ok(!planRoutes([routing], settings).some((o) => o.kind === 'ServersTransport'), 'only Projects with Routes to Services');
});

test("on the waitlist's host its own paths win over any Route, and every Route over its catch-all (decision 131)", () => {
    const manifest = readFileSync(new URL('../../../infra/ingress/waitlist-route.yaml', import.meta.url), 'utf8');
    const rules = manifest
        .split('    - match: ')
        .slice(1)
        .map((rule) => ({ match: rule.split('\n')[0] ?? '', priority: /^ {6}priority: (\d+)$/m.exec(rule)?.[1] }));
    const own = rules.filter((rule) => rule.match.includes('PathPrefix(`/waitlist`) || Path(`/privacy`) || Path(`/imprint`)'));
    const catchAll = rules.filter((rule) => !own.includes(rule));
    assert.equal(own.length, 2);
    assert.equal(catchAll.length, 2);
    for (const rule of own) {
        assert.ok(Number(rule.priority) > priorityOf(`/${'a'.repeat(10_000)}`, true), rule.match);
    }
    // Without a priority Traefik takes the rule's length, also for the longest hostname.
    for (const rule of catchAll) {
        assert.equal(rule.priority, undefined);
        assert.ok(rule.match.replace('WAITLIST_DOMAIN', 'a'.repeat(253)).length < priorityOf('/', false), rule.match);
    }
});
