import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServiceRow } from '@openupstream/sdk';
import type { KubeObject } from '../kube.js';
import { err, ok } from '../result.js';
import { fakeKube } from '../testing/kube.js';
import { NODE_BLOCKS, listNodes } from '../testing/nodes.js';
import { servicesPass } from './loop.js';
import { planServices } from './manifests.js';
import { reconcileServices } from './reconcile.js';

const project = { id: '11111111-1111-4111-8111-111111111111', accountId: 'a', name: 'shop', createdAt: '2026-10-31T00:00:00Z' };
const namespace = `project-${project.id}`;
const digest = `sha256:${'c'.repeat(64)}`;
const row = (overrides: Partial<ServiceRow['service']> = {}, site: ServiceRow['site'] = 'ovh-lim'): ServiceRow => ({
    project,
    service: {
        id: '22222222-2222-4222-8222-222222222222',
        name: 'api',
        image: 'ghcr.io/acme/api:v1',
        imageDigest: digest,
        replicas: 1,
        memoryMb: 256,
        cpuMillicores: 250,
        port: 8080,
        ...overrides,
    },
    pinnedImage: `ghcr.io/acme/api@${digest}`,
    site,
    secretsVersion: 'v1',
    databases: [],
});

type PodSpec = {
    runtimeClassName: string;
    automountServiceAccountToken: boolean;
    imagePullSecrets: unknown;
    affinity: { nodeAffinity: Record<string, unknown> };
    topologySpreadConstraints?: unknown[];
    containers: { image: string; env?: unknown; envFrom: unknown; resources: unknown; ports: unknown }[];
};
const podOf = (object: KubeObject | undefined) =>
    (object?.['spec'] as { template: { metadata: { annotations: Record<string, string> }; spec: PodSpec } }).template;

test("a Project's namespace and NetworkPolicies first, then each Service's Deployment and Service", () => {
    const plan = planServices([row(), row({ id: '33333333-3333-4333-8333-333333333333', name: 'worker' })], NODE_BLOCKS);
    assert.deepEqual(
        plan.map((o) => `${o.kind} ${o.metadata.name}`),
        [
            `Namespace ${namespace}`,
            'NetworkPolicy project-isolation',
            'NetworkPolicy service-egress',
            'Deployment svc-22222222-2222-4222-8222-222222222222',
            'Service svc-22222222-2222-4222-8222-222222222222',
            'Deployment svc-33333333-3333-4333-8333-333333333333',
            'Service svc-33333333-3333-4333-8333-333333333333',
        ],
    );
});

test('a worker without a port gets no Kubernetes Service, no container port and no readiness probe', () => {
    const plan = planServices([row({ port: null })], NODE_BLOCKS);
    assert.deepEqual(plan.filter((o) => o.kind === 'Service'), []);
    const container = podOf(plan.find((o) => o.kind === 'Deployment')).spec.containers[0] as Record<string, unknown> | undefined;
    assert.equal(container?.['ports'], undefined);
    assert.equal(container?.['readinessProbe'], undefined);
    const spec = plan.find((o) => o.kind === 'Deployment')?.['spec'] as { minReadySeconds?: number };
    assert.equal(spec.minReadySeconds, 10, 'a worker that crashes at start does not replace the old pods');
    assert.equal((planServices([row()], NODE_BLOCKS).find((o) => o.kind === 'Deployment')?.['spec'] as { minReadySeconds?: number }).minReadySeconds, undefined);
});

test("the container gets a DATABASE_URL per Database of the Project, the oldest's also as DATABASE_URL, without a password in the manifest", () => {
    assert.equal(podOf(planServices([row()], NODE_BLOCKS).find((o) => o.kind === 'Deployment')).spec.containers[0]?.env, undefined);
    const databases = [
        { id: '44444444-4444-4444-8444-444444444444', name: 'main' },
        { id: '55555555-5555-4555-8555-555555555555', name: 'events-db' },
    ];
    const pod = podOf(planServices([{ ...row(), databases }], NODE_BLOCKS).find((o) => o.kind === 'Deployment'));
    const pooler = (id: string) => `db-${id}-pooler.${namespace}.svc.cluster.local:5432`;
    assert.deepEqual(pod.spec.containers[0]?.env, [
        { name: 'OUP_DATABASE_PASSWORD_MAIN', valueFrom: { secretKeyRef: { name: `db-${databases[0]?.id}-app`, key: 'password' } } },
        { name: 'DATABASE_URL_MAIN', value: `postgres://app:$(OUP_DATABASE_PASSWORD_MAIN)@${pooler(databases[0]?.id ?? '')}/app` },
        { name: 'OUP_DATABASE_PASSWORD_EVENTS_DB', valueFrom: { secretKeyRef: { name: `db-${databases[1]?.id}-app`, key: 'password' } } },
        { name: 'DATABASE_URL_EVENTS_DB', value: `postgres://app:$(OUP_DATABASE_PASSWORD_EVENTS_DB)@${pooler(databases[1]?.id ?? '')}/app` },
        { name: 'DATABASE_URL', value: `postgres://app:$(OUP_DATABASE_PASSWORD_MAIN)@${pooler(databases[0]?.id ?? '')}/app` },
    ]);
});

test('the pod runs the pinned image under gVisor, with the Project Secrets and registry credentials, and no API token', () => {
    const pod = podOf(planServices([row()], NODE_BLOCKS).find((o) => o.kind === 'Deployment'));
    assert.equal(pod.spec.runtimeClassName, 'gvisor');
    assert.equal(pod.spec.automountServiceAccountToken, false);
    assert.deepEqual(pod.spec.imagePullSecrets, [{ name: 'project-registry-auth' }]);
    const [container] = pod.spec.containers;
    assert.equal(container?.image, `ghcr.io/acme/api@${digest}`);
    assert.deepEqual(container?.envFrom, [{ secretRef: { name: 'project-secrets' } }]);
    assert.deepEqual(container?.resources, { requests: { cpu: '250m', memory: '256Mi' }, limits: { cpu: '250m', memory: '256Mi' } });
    assert.deepEqual(container?.ports, [{ name: 'http', containerPort: 8080, protocol: 'TCP' }]);
    assert.equal(pod.metadata.annotations['openupstream.io/secrets-version'], 'v1');
});

test('a single replica prefers its Site; more are spread over both compute Sites', () => {
    const single = podOf(planServices([row()], NODE_BLOCKS).find((o) => o.kind === 'Deployment'));
    assert.deepEqual(single.spec.affinity.nodeAffinity['preferredDuringSchedulingIgnoredDuringExecution'], [
        { weight: 100, preference: { matchExpressions: [{ key: 'topology.kubernetes.io/zone', operator: 'In', values: ['ovh-lim'] }] } },
    ]);
    assert.equal(single.spec.topologySpreadConstraints, undefined);
    const spread = podOf(planServices([row({ replicas: 3 })], NODE_BLOCKS).find((o) => o.kind === 'Deployment'));
    assert.equal(spread.spec.affinity.nodeAffinity['preferredDuringSchedulingIgnoredDuringExecution'], undefined);
    assert.deepEqual(spread.spec.topologySpreadConstraints, [
        {
            maxSkew: 1,
            topologyKey: 'topology.kubernetes.io/zone',
            whenUnsatisfiable: 'DoNotSchedule',
            nodeTaintsPolicy: 'Honor',
            labelSelector: { matchLabels: { 'openupstream.io/service-id': '22222222-2222-4222-8222-222222222222' } },
            matchLabelKeys: ['pod-template-hash'],
        },
    ]);
    for (const pod of [single, spread]) {
        assert.deepEqual(pod.spec.affinity.nodeAffinity['requiredDuringSchedulingIgnoredDuringExecution'], {
            nodeSelectorTerms: [{ matchExpressions: [{ key: 'topology.kubernetes.io/zone', operator: 'In', values: ['hetzner-fsn1', 'ovh-lim'] }] }],
        });
    }
});

type EgressRule = { to: { ipBlock?: { cidr: string; except?: string[] } }[]; ports?: { port: number; protocol: string }[] };
const egressOf = (plan: KubeObject[]) =>
    (plan.find((o) => o.metadata.name === 'service-egress')?.['spec'] as { podSelector: unknown; egress: EgressRule[] });

test('Service pods reach DNS, their own namespace and the internet, never a private range', () => {
    const spec = egressOf(planServices([row()], NODE_BLOCKS));
    assert.deepEqual(spec.podSelector, { matchLabels: { 'openupstream.io/component': 'services' } });
    const internet = spec.egress.find((rule) => rule.to.some((peer) => peer.ipBlock?.cidr === '0.0.0.0/0'));
    assert.deepEqual(internet?.to.map((peer) => peer.ipBlock?.cidr), ['0.0.0.0/0', '::/0']);
    assert.equal(internet?.ports, undefined);
    assert.ok(internet?.to[0]?.ipBlock?.except?.includes('10.0.0.0/8'));
    assert.ok(internet?.to[0]?.ipBlock?.except?.includes('169.254.0.0/16'));
});

test("Service pods reach the nodes' addresses on 80 and 443 only, not the Kubernetes API, kubelet or etcd", () => {
    const spec = egressOf(planServices([row()], NODE_BLOCKS));
    const [v4, v6] = spec.egress.find((rule) => rule.to.some((peer) => peer.ipBlock?.cidr === '0.0.0.0/0'))?.to ?? [];
    for (const cidr of NODE_BLOCKS.v4) {
        assert.ok(v4?.ipBlock?.except?.includes(cidr), cidr);
    }
    assert.ok(v6?.ipBlock?.except?.includes('2001:db8::2/128'));
    const nodeRules = spec.egress.filter((rule) => rule.to.some((peer) => peer.ipBlock?.cidr === '198.51.100.1/32'));
    assert.deepEqual(nodeRules, [
        {
            to: ['192.0.2.3/32', '198.51.100.1/32', '203.0.113.2/32', '2001:db8::2/128'].map((cidr) => ({ ipBlock: { cidr } })),
            ports: [
                { port: 80, protocol: 'TCP' },
                { port: 443, protocol: 'TCP' },
            ],
        },
    ]);
});

test("Service pods reach Traefik's pods on their two ports, for the platform's public hostnames through their own node", () => {
    const policy = planServices([row()], NODE_BLOCKS).find((o) => o.metadata.name === 'service-egress');
    const spec = policy?.['spec'] as { egress: { to: unknown[]; ports?: unknown[] }[] };
    const ingress = spec.egress.find((rule) =>
        rule.to.some((peer) => JSON.stringify(peer).includes('"kubernetes.io/metadata.name":"traefik"')),
    );
    assert.deepEqual(ingress, {
        to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'traefik' } }, podSelector: { matchLabels: { 'app.kubernetes.io/name': 'traefik' } } }],
        ports: [
            { port: 8000, protocol: 'TCP' },
            { port: 8443, protocol: 'TCP' },
        ],
    });
});

test('new Secrets roll the Service: the version is on the pod template', () => {
    const before = podOf(planServices([row()], NODE_BLOCKS).find((o) => o.kind === 'Deployment'));
    const after = podOf(planServices([{ ...row(), secretsVersion: 'v2' }], NODE_BLOCKS).find((o) => o.kind === 'Deployment'));
    assert.notDeepEqual(before.metadata.annotations, after.metadata.annotations);
});


test("a deleted Service's Deployment goes before its Service; the shared NetworkPolicy is never listed for pruning", async () => {
    const gone = 'svc-99999999-9999-4999-8999-999999999999';
    const { kube, removed } = fakeKube([
        { apiVersion: 'apps/v1', kind: 'Deployment', namespace, name: gone },
        { apiVersion: 'v1', kind: 'Service', namespace, name: gone },
    ]);
    const report = await reconcileServices(kube, [row()], NODE_BLOCKS);
    assert.deepEqual(removed, [`Deployment ${gone}`, `Service ${gone}`]);
    assert.equal(report.failed.length, 0);
    const shared = planServices([row()], NODE_BLOCKS).filter((o) => o.metadata.labels?.['openupstream.io/component'] !== 'services');
    assert.deepEqual(shared.map((o) => o.kind), ['Namespace', 'NetworkPolicy']);
});

test('without the Services nothing is applied or deleted', async () => {
    const { kube, applied, removed } = fakeKube([{ apiVersion: 'apps/v1', kind: 'Deployment', namespace, name: 'svc-x' }]);
    const log = await servicesPass(async () => err({ kind: 'unreachable', message: 'down' }), listNodes, kube);
    assert.equal(log.msg, 'cannot get the Services');
    assert.deepEqual([applied, removed], [[], []]);
    const done = await servicesPass(async () => ok([row()]), listNodes, kube);
    assert.equal(done['services'], 1);
});

test('without the Nodes nothing is applied or deleted, so the egress policy in place stays', async () => {
    const existing = [{ apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', namespace, name: 'service-egress' }];
    const failures = [
        async () => err({ status: 403, message: 'forbidden' }),
        async () => ok([]),
        async () => ok([{ name: 'new', addresses: [] }]),
    ];
    for (const failing of failures) {
        const { kube, applied, removed } = fakeKube(existing);
        const log = await servicesPass(async () => ok([row()]), failing, kube);
        assert.equal(log.msg, 'cannot get the Nodes, nothing applied');
        assert.deepEqual([applied, removed], [[], []]);
    }
});

test('the Deployment carries the spec version the control plane compares its row with', () => {
    const deployment = planServices([row()], NODE_BLOCKS).find((o) => o.kind === 'Deployment');
    assert.equal(deployment?.metadata.annotations?.['openupstream.io/spec-version'], `ghcr.io/acme/api@${digest}|1|256|250|8080|ovh-lim|v1`);
});
