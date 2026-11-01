import { test } from 'node:test';
import assert from 'node:assert/strict';
import { networkPolicyFor, projectObjectsFor } from './kubernetes.js';

const projectId = '11111111-1111-4111-8111-111111111111';

test("a Project's pods accept connections only from each other, Traefik and CloudNativePG's operator", () => {
    const policy = networkPolicyFor(projectId);
    assert.equal(policy.metadata.namespace, `project-${projectId}`);
    assert.deepEqual(policy.spec, {
        podSelector: {},
        policyTypes: ['Ingress'],
        ingress: [
            { from: [{ podSelector: {} }] },
            { from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'traefik' } } }] },
            { from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'cnpg-system' } } }] },
        ],
    });
});

test('the NetworkPolicy is applied right after the namespace, before anything runs in it', () => {
    assert.deepEqual(
        projectObjectsFor({ id: projectId, name: 'shop' }).map((object) => object.kind),
        ['Namespace', 'NetworkPolicy'],
    );
});
