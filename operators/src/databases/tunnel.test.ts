import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Database, DatabaseRoleRow, Project } from '@openupstream/sdk';
import type { KubeObject } from '../kube.js';
import { COMPONENT_LABEL } from '../kubernetes.js';
import { type DatabaseConfig, OWNER_CONNECTION_LIMIT, databaseManifests } from './manifests.js';
import { type DatabaseRow, planDatabases } from './reconcile.js';
import { TUNNEL_COMPONENT, type TunnelSettings } from './tunnel.js';

const project: Project = {
    id: '0b8e6c9e-7a4f-4e39-9a7e-1f3f0d6f2a11',
    accountId: '9c4f1d2e-3b5a-4c6d-8e7f-0a1b2c3d4e5f',
    name: 'shop-prod',
    createdAt: '2026-10-17T00:00:00Z',
};
const other: Project = { ...project, id: '1c9f7dae-8b5a-4f4a-8b8f-2a4a1e7a3b22', name: 'shop-dev' };
const database = (id: string, owner: Project = project): Database => ({
    id,
    projectId: owner.id,
    name: 'orders',
    homeSite: 'hetzner-fsn1',
    memoryMb: 512,
    storageGb: 10,
    autoGrow: true,
    maxStorageGb: null,
    createdAt: '2026-10-17T00:00:00Z',
});
const orders = database('5d1c2a33-90b4-4c8f-8f3e-6c2b9d0e7f44');
const config: DatabaseConfig = {
    postgresImage: 'ghcr.io/openupstream/postgres@sha256:0000000000000000000000000000000000000000000000000000000000000000',
    storageClass: 'topolvm-provisioner',
    backup: { bucket: 'openupstream-backups', prefix: 'c1', credentialsSecret: 'backup-s3', retention: '30d', schedule: '0 0 3 * * *' },
};
const credentials = { ACCESS_KEY_ID: 'aWQ=', ACCESS_SECRET_KEY: 'c2VjcmV0' };
const tunnel: TunnelSettings = {
    forwarderImage: 'ghcr.io/openupstream/operators@sha256:1111111111111111111111111111111111111111111111111111111111111111',
    authUrl: 'http://control-plane.project-00000000-0000-4000-8000-000000000002.svc:8080/v1/database-tunnel',
};
const roles: DatabaseRoleRow[] = [
    { id: 'aaaaaaaa-1111-4111-8111-111111111111', access: 'read' },
    { id: 'bbbbbbbb-2222-4222-8222-222222222222', access: 'write' },
    { id: 'cccccccc-3333-4333-8333-333333333333', access: 'owner' },
];
const hostname = `pg-${project.id}.openupstream.app`;
const find = (objects: readonly KubeObject[], kind: string) => objects.find((object) => object.kind === kind) as KubeObject & { spec: any };

test('each role is a login role with its Secret: read and write by predefined roles, owner a member of app with a connection limit', () => {
    const result = databaseManifests(project, orders, config, roles);
    assert.ok(result.ok);
    const managed = (result.value.cluster.spec as { managed?: { roles?: unknown[] } }).managed?.roles;
    assert.deepEqual(managed, [
        {
            name: 'oup_read_aaaaaaaa111141118111111111111111',
            comment: 'openupstream read role aaaaaaaa-1111-4111-8111-111111111111',
            ensure: 'present',
            login: true,
            inherit: true,
            inRoles: ['pg_read_all_data'],
            passwordSecret: { name: 'pg-role-aaaaaaaa-1111-4111-8111-111111111111' },
            connectionLimit: -1,
        },
        {
            name: 'oup_write_bbbbbbbb222242228222222222222222',
            comment: 'openupstream write role bbbbbbbb-2222-4222-8222-222222222222',
            ensure: 'present',
            login: true,
            inherit: true,
            inRoles: ['pg_read_all_data', 'pg_write_all_data'],
            passwordSecret: { name: 'pg-role-bbbbbbbb-2222-4222-8222-222222222222' },
            connectionLimit: -1,
        },
        {
            name: 'oup_owner_cccccccc333343338333333333333333',
            comment: 'openupstream owner role cccccccc-3333-4333-8333-333333333333',
            ensure: 'present',
            login: true,
            inherit: true,
            inRoles: ['app'],
            passwordSecret: { name: 'pg-role-cccccccc-3333-4333-8333-333333333333' },
            connectionLimit: OWNER_CONNECTION_LIMIT,
        },
    ]);
    assert.ok(managed.every((role) => (role as { name: string }).name.length <= 63));
});

test('a dropped role stays in the Cluster as absent, named only, without a Secret', () => {
    const result = databaseManifests(project, orders, config, [roles[0]!, { ...roles[2]!, dropped: true }]);
    assert.ok(result.ok);
    const managed = (result.value.cluster.spec as { managed?: { roles?: unknown[] } }).managed?.roles;
    assert.equal(managed?.length, 2);
    assert.deepEqual(managed?.[1], {
        name: 'oup_owner_cccccccc333343338333333333333333',
        comment: 'openupstream owner role cccccccc-3333-4333-8333-333333333333, dropped',
        ensure: 'absent',
    });
});

test('without roles the Cluster has no managed section, as before', () => {
    const result = databaseManifests(project, orders, config);
    assert.ok(result.ok);
    assert.equal('managed' in result.value.cluster.spec, false);
});

test('a role with a malformed id or level makes the row invalid', () => {
    const result = databaseManifests(project, orders, config, [{ id: 'x; drop', access: 'read' }, { id: roles[0]!.id, access: 'admin' as 'read' }]);
    assert.ok(!result.ok);
    assert.deepEqual(result.error, [
        { kind: 'invalid-role', id: 'x; drop', access: 'read' },
        { kind: 'invalid-role', id: roles[0]!.id, access: 'admin' },
    ]);
});

test('a Project with a tunnel host gets its tunnel after its namespace and policies; a Project without one does not', () => {
    const rows: DatabaseRow[] = [
        { project, database: orders, roles, tunnelHostname: hostname },
        { project: other, database: database('7a2e4b55-1c3d-4e6f-8a9b-0c1d2e3f4a5b', other) },
    ];
    const plan = planDatabases(rows, config, credentials, tunnel);
    assert.deepEqual(
        plan.projects.map((chain) => chain.map((object) => `${object.kind}/${object.metadata.name}`)),
        [
            [
                `Namespace/project-${project.id}`,
                'NetworkPolicy/project-isolation',
                'NetworkPolicy/database-metrics',
                'Secret/backup-s3',
                'NetworkPolicy/database-tunnel-egress',
                'Deployment/database-tunnel',
                'Service/database-tunnel',
                'Middleware/database-tunnel-rate-limit',
                'Middleware/database-tunnel-auth',
                'IngressRoute/database-tunnel',
            ],
            [`Namespace/project-${other.id}`, 'NetworkPolicy/project-isolation', 'NetworkPolicy/database-metrics', 'Secret/backup-s3'],
        ],
    );
    assert.ok(plan.projects[0]!.slice(4).every((object) => object.metadata.labels?.[COMPONENT_LABEL] === TUNNEL_COMPONENT));
    assert.ok(plan.projects[0]!.slice(4).every((object) => object.metadata.namespace === `project-${project.id}`));
});

test('without tunnel settings the roles still reach the Cluster, but no tunnel is applied', () => {
    const plan = planDatabases([{ project, database: orders, roles, tunnelHostname: hostname }], config, credentials);
    assert.equal(plan.projects[0]!.length, 4);
    const cluster = find(plan.databases[0]!, 'Cluster');
    assert.equal(cluster.spec.managed.roles.length, 3);
});

test('the forwarder: one pod under gVisor from the operators image, no token, no privileges, only in the compute Sites', () => {
    const [objects] = planDatabases([{ project, database: orders, roles, tunnelHostname: hostname }], config, credentials, tunnel).projects;
    const pod = find(objects!, 'Deployment').spec;
    assert.equal(pod.replicas, 1);
    const spec = pod.template.spec;
    assert.equal(spec.runtimeClassName, 'gvisor');
    assert.equal(spec.automountServiceAccountToken, false);
    assert.equal(spec.securityContext.runAsNonRoot, true);
    assert.deepEqual(spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].values, [
        'hetzner-fsn1',
        'ovh-lim',
    ]);
    const [container] = spec.containers;
    assert.equal(container.image, tunnel.forwarderImage);
    assert.deepEqual(container.command, ['node', 'operators/dist/forwarder/main.js']);
    assert.deepEqual(container.env[1], { name: 'NAMESPACE', valueFrom: { fieldRef: { fieldPath: 'metadata.namespace' } } });
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(container.securityContext.capabilities, { drop: ['ALL'] });
    assert.equal(container.resources.limits.memory, '128Mi');
});

test('the forwarder may reach DNS and its Databases on 5432, nothing else', () => {
    const [objects] = planDatabases([{ project, database: orders, roles, tunnelHostname: hostname }], config, credentials, tunnel).projects;
    const policy = objects!.find((object) => object.metadata.name === 'database-tunnel-egress') as KubeObject & { spec: any };
    assert.deepEqual(policy.spec.podSelector, { matchLabels: { [COMPONENT_LABEL]: TUNNEL_COMPONENT } });
    assert.deepEqual(policy.spec.policyTypes, ['Egress']);
    assert.equal(policy.spec.egress.length, 2);
    assert.deepEqual(policy.spec.egress[1], {
        to: [
            { podSelector: { matchExpressions: [{ key: 'cnpg.io/poolerName', operator: 'Exists' }] } },
            { podSelector: { matchExpressions: [{ key: 'cnpg.io/cluster', operator: 'Exists' }] } },
        ],
        ports: [{ port: 5432, protocol: 'TCP' }],
    });
});

test('Traefik serves the tunnel host with the default certificate and asks the control plane first, with the token alone', () => {
    const [objects] = planDatabases([{ project, database: orders, roles, tunnelHostname: hostname }], config, credentials, tunnel).projects;
    const route = find(objects!, 'IngressRoute').spec;
    assert.deepEqual(route.entryPoints, ['websecure']);
    assert.equal(route.routes[0].match, `Host(\`${hostname}\`)`);
    assert.deepEqual(route.routes[0].middlewares, [{ name: 'database-tunnel-rate-limit' }, { name: 'database-tunnel-auth' }]);
    assert.deepEqual(route.routes[0].services, [{ name: 'database-tunnel', port: 8080 }]);
    assert.deepEqual(route.tls, {});
    const middleware = (name: string) => (objects!.find((object) => object.metadata.name === name) as KubeObject & { spec: unknown }).spec;
    assert.deepEqual(middleware('database-tunnel-rate-limit'), { rateLimit: { average: 10, period: '1s', burst: 50 } });
    assert.deepEqual(middleware('database-tunnel-auth'), { forwardAuth: { address: tunnel.authUrl, authRequestHeaders: ['Authorization'] } });
});
