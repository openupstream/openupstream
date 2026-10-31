import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DomainRouting } from '@openupstream/sdk';
import { type Kube, type KubeObject, type ObjectRef, refOf } from '../kube.js';
import { err, ok } from '../result.js';
import { planRoutes } from './manifests.js';
import { reconcileRoutes } from './reconcile.js';
import { routesPass } from './loop.js';

const settings = { clusterIssuer: 'letsencrypt-staging' };
/** What the operator lists for pruning: its objects, not the shared namespace and NetworkPolicy. */
const ours = (object: KubeObject) => object.metadata.labels?.['openupstream.io/component'] === 'routes';

const routing: DomainRouting = {
    projectId: '11111111-1111-4111-8111-111111111111',
    projectName: 'shop',
    domainId: '22222222-2222-4222-8222-222222222222',
    hostname: 'shop-a1b2c3d4.openupstream.app',
    kind: 'default',
    routes: [{ id: '44444444-4444-4444-8444-444444444444', pathPrefix: '/', kind: 'bucket', bucketName: 'shop-site', spaFallback: true }],
};

/** A cluster holding `existing` objects of ours; records applies and removes. */
const fakeKube = (existing: ObjectRef[]) => {
    const applied: string[] = [];
    const removed: string[] = [];
    const listed: string[] = [];
    const kube: Kube = {
        apply: async (object) => {
            applied.push(`${object.kind} ${object.metadata.namespace ?? ''}/${object.metadata.name}`);
            return ok(undefined);
        },
        readSecret: async () => ok(undefined),
        list: async (apiVersion, kind, selector) => {
            listed.push(selector);
            return ok(existing.filter((ref) => ref.apiVersion === apiVersion && ref.kind === kind));
        },
        remove: async (ref) => {
            removed.push(`${ref.kind} ${ref.name}`);
            return ok(undefined);
        },
    };
    return { kube, applied, removed, listed };
};

test('applies the plan and deletes only the objects of ours no longer wanted', async () => {
    const stale: ObjectRef[] = [
        { apiVersion: 'traefik.io/v1alpha1', kind: 'IngressRoute', namespace: 'project-x', name: 'domain-gone' },
        { apiVersion: 'traefik.io/v1alpha1', kind: 'Middleware', namespace: 'project-x', name: 'route-gone-bucket' },
    ];
    const current = planRoutes([routing], settings).filter(ours).map(refOf);
    const { kube, applied, removed, listed } = fakeKube([...current, ...stale]);
    const report = await reconcileRoutes(kube, [routing], settings);
    assert.equal(applied.length, planRoutes([routing], settings).length);
    assert.deepEqual(removed, ['IngressRoute domain-gone', 'Middleware route-gone-bucket']);
    assert.deepEqual(listed, Array(5).fill('openupstream.io/component=routes'));
    assert.equal(report.failed.length, 0);
});

test('an empty routing table takes every Route down', async () => {
    const current = planRoutes([routing], settings).filter(ours).map(refOf);
    const { kube, removed } = fakeKube(current);
    await reconcileRoutes(kube, [], settings);
    assert.equal(removed.length, current.length);
});

test('without the routing table nothing is applied or deleted', async () => {
    const { kube, applied, removed } = fakeKube(planRoutes([routing], settings).map(refOf));
    const log = await routesPass(async () => err({ kind: 'unreachable', message: 'ECONNREFUSED' }), kube, settings);
    assert.equal(log.msg, 'cannot get the routing table');
    assert.deepEqual([applied, removed], [[], []]);
});

test('each Project in order, Projects side by side', async () => {
    const other = { ...routing, projectId: '66666666-6666-4666-8666-666666666666', domainId: '77777777-7777-4777-8777-777777777777' };
    const { kube, applied } = fakeKube([]);
    await reconcileRoutes(kube, [routing, other], settings);
    for (const project of [routing.projectId, other.projectId]) {
        const own = planRoutes([routing, other], settings)
            .filter((o) => (o.metadata.namespace ?? o.metadata.name) === `project-${project}`)
            .map((o) => `${o.kind} ${o.metadata.namespace ?? ''}/${o.metadata.name}`);
        assert.deepEqual(applied.filter((entry) => own.includes(entry)), own);
    }
});

test("a deleted custom domain's Certificate is pruned after its IngressRoute", async () => {
    const custom = { ...routing, domainId: '88888888-8888-4888-8888-888888888888', hostname: 'www.shop.example', kind: 'custom' as const };
    const current = planRoutes([routing, custom], settings).filter(ours).map(refOf);
    const { kube, removed } = fakeKube(current);
    await reconcileRoutes(kube, [routing], settings);
    assert.deepEqual(removed, ['IngressRoute domain-88888888-8888-4888-8888-888888888888', 'Certificate domain-88888888-8888-4888-8888-888888888888']);
});
