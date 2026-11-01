import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServiceRow } from '@openupstream/sdk';
import type { KubeObject } from '../kube.js';
import { err, ok } from '../result.js';
import { fakeKube } from '../testing/kube.js';
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
    const plan = planServices([row(), row({ id: '33333333-3333-4333-8333-333333333333', name: 'worker' })]);
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
    const plan = planServices([row({ port: null })]);
    assert.deepEqual(plan.filter((o) => o.kind === 'Service'), []);
    const container = podOf(plan.find((o) => o.kind === 'Deployment')).spec.containers[0] as Record<string, unknown> | undefined;
    assert.equal(container?.['ports'], undefined);
    assert.equal(container?.['readinessProbe'], undefined);
    const spec = plan.find((o) => o.kind === 'Deployment')?.['spec'] as { minReadySeconds?: number };
    assert.equal(spec.minReadySeconds, 10, 'a worker that crashes at start does not replace the old pods');
    assert.equal((planServices([row()]).find((o) => o.kind === 'Deployment')?.['spec'] as { minReadySeconds?: number }).minReadySeconds, undefined);
});

test("the container gets a DATABASE_URL per Database of the Project, the oldest's also as DATABASE_URL, without a password in the manifest", () => {
    assert.equal(podOf(planServices([row()]).find((o) => o.kind === 'Deployment')).spec.containers[0]?.env, undefined);
    const databases = [
        { id: '44444444-4444-4444-8444-444444444444', name: 'main' },
        { id: '55555555-5555-4555-8555-555555555555', name: 'events-db' },
    ];
    const pod = podOf(planServices([{ ...row(), databases }]).find((o) => o.kind === 'Deployment'));
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
    const pod = podOf(planServices([row()]).find((o) => o.kind === 'Deployment'));
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
    const single = podOf(planServices([row()]).find((o) => o.kind === 'Deployment'));
    assert.deepEqual(single.spec.affinity.nodeAffinity['preferredDuringSchedulingIgnoredDuringExecution'], [
        { weight: 100, preference: { matchExpressions: [{ key: 'topology.kubernetes.io/zone', operator: 'In', values: ['ovh-lim'] }] } },
    ]);
    assert.equal(single.spec.topologySpreadConstraints, undefined);
    const spread = podOf(planServices([row({ replicas: 3 })]).find((o) => o.kind === 'Deployment'));
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

test('Service pods reach DNS, their own namespace and the internet, never a private range', () => {
    const policy = planServices([row()]).find((o) => o.metadata.name === 'service-egress');
    const spec = policy?.['spec'] as { podSelector: unknown; egress: { to: { ipBlock?: { cidr: string; except: string[] } }[] }[] };
    assert.deepEqual(spec.podSelector, { matchLabels: { 'openupstream.io/component': 'services' } });
    const blocks = spec.egress.flatMap((rule) => rule.to.flatMap((peer) => (peer.ipBlock ? [peer.ipBlock] : [])));
    assert.deepEqual(blocks.map((block) => block.cidr), ['0.0.0.0/0', '::/0']);
    assert.ok(blocks[0]?.except.includes('10.0.0.0/8'));
    assert.ok(blocks[0]?.except.includes('169.254.0.0/16'));
});

test('new Secrets roll the Service: the version is on the pod template', () => {
    const before = podOf(planServices([row()]).find((o) => o.kind === 'Deployment'));
    const after = podOf(planServices([{ ...row(), secretsVersion: 'v2' }]).find((o) => o.kind === 'Deployment'));
    assert.notDeepEqual(before.metadata.annotations, after.metadata.annotations);
});


test("a deleted Service's Deployment goes before its Service; the shared NetworkPolicy is never listed for pruning", async () => {
    const gone = 'svc-99999999-9999-4999-8999-999999999999';
    const { kube, removed } = fakeKube([
        { apiVersion: 'apps/v1', kind: 'Deployment', namespace, name: gone },
        { apiVersion: 'v1', kind: 'Service', namespace, name: gone },
    ]);
    const report = await reconcileServices(kube, [row()]);
    assert.deepEqual(removed, [`Deployment ${gone}`, `Service ${gone}`]);
    assert.equal(report.failed.length, 0);
    const shared = planServices([row()]).filter((o) => o.metadata.labels?.['openupstream.io/component'] !== 'services');
    assert.deepEqual(shared.map((o) => o.kind), ['Namespace', 'NetworkPolicy']);
});

test('without the Services nothing is applied or deleted', async () => {
    const { kube, applied, removed } = fakeKube([{ apiVersion: 'apps/v1', kind: 'Deployment', namespace, name: 'svc-x' }]);
    const log = await servicesPass(async () => err({ kind: 'unreachable', message: 'down' }), kube);
    assert.equal(log.msg, 'cannot get the Services');
    assert.deepEqual([applied, removed], [[], []]);
    const done = await servicesPass(async () => ok([row()]), kube);
    assert.equal(done['services'], 1);
});

test('the Deployment carries the spec version the control plane compares its row with', () => {
    const deployment = planServices([row()]).find((o) => o.kind === 'Deployment');
    assert.equal(deployment?.metadata.annotations?.['openupstream.io/spec-version'], `ghcr.io/acme/api@${digest}|1|256|250|8080|ovh-lim|v1`);
});
