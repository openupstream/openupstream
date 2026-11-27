// Tests for the dev-cluster scripts' own logic (ARCHITECTURE.md, decision
// 109): the recorded layout, the Sites' node labels (ADR-0007), the entry
// scripts' node checks and dns.sh's records. kubectl and curl are stubs on PATH; nothing reaches a cluster or
// bunny.net. Run by `npm test` at the repository root; needs bash and jq.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const stubs = mkdtempSync(join(tmpdir(), 'dev-cluster-stubs-'));

// kubectl: the layout from LAYOUT_STUB (KUBECTL_FAIL=1 fails every call),
// whether a node has the gVisor label from LABELED_STUB, the nodes as JSON
// from NODES_JSON_STUB. Writes, node labels and annotations included (which
// check_sites must never make), go to
// $STUB_LOG.
writeFileSync(
    join(stubs, 'kubectl'),
    `#!/usr/bin/env bash
[[ \${KUBECTL_FAIL:-} == 1 ]] && { echo "connection refused" >&2; exit 1; }
args="$*"
case $args in
  *"get configmap cluster-layout"*clusterId*) [[ \${CLUSTER_ID_FAIL:-} == 1 ]] && exit 1; printf '%s' "\${CLUSTER_ID_STUB:-}" ;;
  *"get configmap cluster-layout"*) printf '%s' "\${LAYOUT_STUB:-}" ;;
  *"create configmap"*) echo "configmap $args" >>"$STUB_LOG"; echo '{}' ;;
  *"create namespace"*) echo '{}' ;;
  "apply -f -") cat >/dev/null ;;
  "get nodes -o json") printf '%s' "\${NODES_JSON_STUB:-}" ;;
  "get nodes -l openupstream.io/compute-site=true -o json")
    printf '%s' "$NODES_JSON_STUB" | jq '.items |= map(select(.metadata.labels["openupstream.io/compute-site"] == "true"))' ;;
  *"openupstream.io/gvisor=true"*) [[ \${LABELED_STUB:-1} == 1 ]] && echo node/a ;;
  "label node "* | "annotate node "*) echo "$args" >>"$STUB_LOG" ;;
  *"get runtimeclass"*) echo runtimeclass.node.k8s.io/gvisor ;;
  *"wait --for=condition=Ready node"*) echo "node/mini condition met" ;;
  *"runtimeclass.yaml"*) echo "applied $args" >>"$STUB_LOG" ;;
  *) echo "unexpected: kubectl $args" >&2; exit 9 ;;
esac
`,
);
// curl: the bunny.net API with the zone dev.example.com (id 7) holding
// a stale record `home` and someone else's record `other`. PUT and DELETE
// are written to $STUB_LOG.
writeFileSync(
    join(stubs, 'curl'),
    `#!/usr/bin/env bash
method=GET body=
while [[ $# -gt 1 ]]; do case $1 in -X) method=$2; shift ;; -d) body=$2; shift ;; esac; shift; done
url=$1
case "$method $url" in
  "GET https://api.bunny.net/dnszone?search=dev.example.com") echo '{"Items":[{"Domain":"dev.example.com","Id":7},{"Domain":"a.dev.example.com","Id":8}]}' ;;
  "GET https://api.bunny.net/dnszone?search="*) echo '{"Items":[]}' ;;
  "GET https://api.bunny.net/dnszone/7") echo '{"Records":[{"Id":1,"Type":0,"Name":"home","Value":"10.0.0.9"},{"Id":2,"Type":0,"Name":"other","Value":"1.1.1.1"},{"Id":3,"Type":0,"Name":"api.home","Value":"10.0.0.9"},{"Id":4,"Type":0,"Name":"pub","Value":"203.0.113.0","MonitorType":0}]}' ;;
  PUT*) echo "PUT $(jq -c . <<<"$body")" >>"$STUB_LOG"; echo '{}' ;;
  DELETE*) echo "DELETE \${url##*/}" >>"$STUB_LOG" ;;
  *) echo "unexpected: curl $method $url" >&2; exit 9 ;;
esac
`,
);
// ssh: \`-G\` resolves the target to SSH_HOSTNAME_STUB (or its host part);
// K3S_INSTALLED_STUB=1 makes \`test -x /usr/local/bin/k3s\` succeed; the
// kubeconfig is k3s's own. Every remote command goes to $STUB_LOG.
writeFileSync(
    join(stubs, 'ssh'),
    `#!/usr/bin/env bash
if [[ $1 == -G ]]; then target=$2; echo "hostname \${SSH_HOSTNAME_STUB:-\${target#*@}}"; exit 0; fi
args="$*"
echo "ssh $args" >>"$STUB_LOG"
case $args in
  *"test -x /usr/local/bin/k3s"*) [[ \${K3S_INSTALLED_STUB:-0} == 1 ]] ;;
  *"test -d /sys/kernel/security/apparmor"*) [[ \${APPARMOR_STUB:-1} == 1 ]] ;;
  *"apparmor_parser"*) echo "profile: $(grep -c '^profile cri-containerd.apparmor.d ')" >>"$STUB_LOG" ;;
  *"bash -s"*) cat >/dev/null ;;
  *"k3s kubectl get nodes"*) printf '%s' "\${EXTERNAL_IP_STUB:-}" ;;
  *"k3s.yaml"*) printf 'clusters:\n- cluster:\n    server: https://127.0.0.1:6443\n  name: default\n' ;;
esac
`,
);
chmodSync(join(stubs, 'ssh'), 0o755);
chmodSync(join(stubs, 'kubectl'), 0o755);
chmodSync(join(stubs, 'curl'), 0o755);
const keyFile = join(stubs, 'bunny-api-key');
writeFileSync(keyFile, 'key\n');

const computeLabels = (site) => ({ 'topology.kubernetes.io/zone': site, 'openupstream.io/compute-site': 'true' });
const singleNodeJson = JSON.stringify({
    items: [
        {
            metadata: { labels: { ...computeLabels('hetzner-fsn1'), 'openupstream.io/default-site': 'true' } },
            status: {
                addresses: [
                    { type: 'InternalIP', address: 'fd00::5' },
                    { type: 'InternalIP', address: '192.168.1.50' },
                    { type: 'Hostname', address: 'mini' },
                ],
            },
        },
    ],
});
// Two compute nodes and a third Site's node, which gets no record.
const multiNodeJson = JSON.stringify({
    items: ['hetzner-fsn1', 'ovh-lim', 'netcup-nbg'].map((site, i) => ({
        metadata: { labels: i < 2 ? computeLabels(site) : { 'topology.kubernetes.io/zone': site } },
        status: {
            addresses: [
                { type: 'InternalIP', address: `10.0.1.${i}` },
                { type: 'ExternalIP', address: `203.0.113.${i}` },
            ],
        },
    })),
});

/**
 * Nodes as `kubectl get nodes -o json` prints them, from
 * [name, site, { compute, default, tainted, description }]; a site of null
 * leaves out the zone label.
 */
const nodes = (...list) =>
    JSON.stringify({
        items: list.map(([name, site, { compute = false, default: isDefault = false, tainted = false, description } = {}]) => ({
            metadata: {
                name,
                labels: {
                    ...(site ? { 'topology.kubernetes.io/zone': site } : {}),
                    ...(compute ? { 'openupstream.io/compute-site': 'true' } : {}),
                    ...(isDefault ? { 'openupstream.io/default-site': 'true' } : {}),
                },
                ...(description ? { annotations: { 'openupstream.io/site-description': description } } : {}),
            },
            spec: tainted ? { taints: [{ key: 'openupstream.io/third-site', value: 'true', effect: 'NoSchedule' }] } : {},
        })),
    });

/** Runs a command in infra/dev-cluster with the stubs first on PATH; returns its status, stderr and stub log. */
const run = (command, env = {}) => {
    const log = join(mkdtempSync(join(tmpdir(), 'dev-cluster-log-')), 'log');
    writeFileSync(log, '');
    const result = spawnSync('bash', ['-c', command], {
        cwd: here,
        encoding: 'utf8',
        env: {
            PATH: `${stubs}:${process.env.PATH}`,
            HOME: stubs,
            BUNNY_API_KEY_FILE: keyFile,
            STUB_LOG: log,
            ...env,
        },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, log: readFileSync(log, 'utf8') };
};
const settings = 'set -euo pipefail; source ./lib.sh; load_layout; load_domains; echo "$LAYOUT $SITE_REPLICAS $CLUSTER_ISSUER $PLATFORM_DOMAIN $CUSTOMER_DOMAIN"';

test('multi-node defaults to the Hetzner dev zones and Let\'s Encrypt staging', () => {
    const { status, stdout } = run(settings, { LAYOUT_STUB: 'multi-node' });
    assert.equal(status, 0);
    assert.equal(stdout.trim(), 'multi-node 2 letsencrypt-staging dev.openupstream.com dev.openupstream.app');
});

test('single-node runs one replica, uses production certificates and needs both domains', () => {
    const ok = run(settings, { LAYOUT_STUB: 'single-node', PLATFORM_DOMAIN: 'a.example.com', CUSTOMER_DOMAIN: 'b.example.app' });
    assert.equal(ok.stdout.trim(), 'single-node 1 letsencrypt a.example.com b.example.app');
    const missing = run(settings, { LAYOUT_STUB: 'single-node', PLATFORM_DOMAIN: 'a.example.com' });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /set CUSTOMER_DOMAIN/);
});

test('a step refuses a cluster without a recorded layout, and says so when it cannot read one', () => {
    const none = run(settings);
    assert.notEqual(none.status, 0);
    assert.match(none.stderr, /no cluster layout recorded/);
    const unreachable = run(settings, { KUBECTL_FAIL: '1' });
    assert.notEqual(unreachable.status, 0);
    assert.match(unreachable.stderr, /is KUBECONFIG right/);
    assert.doesNotMatch(unreachable.stderr, /no cluster layout recorded/);
});

test('a recorded layout is never changed', () => {
    const changed = run('set -euo pipefail; source ./lib.sh; record_layout single-node', { LAYOUT_STUB: 'multi-node' });
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /installed as multi-node/);
    assert.equal(changed.log, '');
    const same = run('set -euo pipefail; source ./lib.sh; record_layout multi-node', { LAYOUT_STUB: 'multi-node' });
    assert.equal(same.status, 0);
    assert.match(same.log, /layout=multi-node/);
});

test('the cluster id is generated once, kept, and never changed', () => {
    const fresh = run('set -euo pipefail; source ./lib.sh; record_layout multi-node');
    assert.equal(fresh.status, 0, fresh.stderr);
    assert.match(fresh.log, /clusterId=\d{8}-[0-9a-f]{6}/);
    const kept = run('set -euo pipefail; source ./lib.sh; record_layout multi-node', { LAYOUT_STUB: 'multi-node', CLUSTER_ID_STUB: 'c1' });
    assert.match(kept.log, /clusterId=c1/);
    const chosen = run('set -euo pipefail; source ./lib.sh; record_layout multi-node', { CLUSTER_ID: 'production' });
    assert.match(chosen.log, /clusterId=production/);
    const changed = run('set -euo pipefail; source ./lib.sh; record_layout multi-node', { LAYOUT_STUB: 'multi-node', CLUSTER_ID_STUB: 'c1', CLUSTER_ID: 'c2' });
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /id is c1; it cannot become c2/);
    const invalid = run('set -euo pipefail; source ./lib.sh; record_layout multi-node', { CLUSTER_ID: 'Prod/1' });
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.log, '');
});

test('a cluster id that cannot be read is never replaced by a new one', () => {
    for (const command of ['load_layout', 'record_layout multi-node']) {
        const { status, stderr, log } = run(`set -euo pipefail; source ./lib.sh; ${command}`, { LAYOUT_STUB: 'multi-node', CLUSTER_ID_FAIL: '1' });
        assert.notEqual(status, 0, command);
        assert.match(stderr, /cannot read the cluster id/);
        assert.equal(log, '', `${command} writes nothing`);
    }
});

test('a cluster installed without an id gets one on the next step, its layout kept', () => {
    const { status, stderr, log } = run('set -euo pipefail; source ./lib.sh; load_layout; echo "$CLUSTER_ID"', { LAYOUT_STUB: 'single-node' });
    assert.equal(status, 0, stderr);
    assert.match(log, /layout=single-node --from-literal=clusterId=\d{8}-[0-9a-f]{6}/);
    assert.match(stderr, /recorded the cluster id/);
});

test('platform.sh with SIGNUP=closed needs a waitlist host other than the platform domain, before it changes anything', () => {
    for (const env of [{}, { WAITLIST_DOMAIN: 'dev.openupstream.com' }]) {
        const { status, stderr, log } = run('./platform.sh', { LAYOUT_STUB: 'multi-node', CLUSTER_ID_STUB: 'c1', SIGNUP: 'closed', MAIL: 'log', ...env });
        assert.notEqual(status, 0);
        assert.match(stderr, /SIGNUP=closed needs WAITLIST_DOMAIN.*dev\.openupstream\.com serves the dashboard/);
        assert.equal(log, '');
    }
});

test("platform.sh refuses a WEBSITE_PROJECT_ID that is not a Project's id, before it changes anything", () => {
    for (const id of ['website', '7b0c1c0e-5d0a-4a43-9f3e']) {
        const { status, stderr, log } = run('./platform.sh', { LAYOUT_STUB: 'multi-node', CLUSTER_ID_STUB: 'c1', WEBSITE_PROJECT_ID: id });
        assert.notEqual(status, 0);
        assert.match(stderr, /WEBSITE_PROJECT_ID must be the website Project's id/);
        assert.equal(log, '');
    }
});

const checkSites = (layout, env) => run(`set -euo pipefail; source ./lib.sh; check_sites ${layout}`, env);
// The production layout: two compute Sites, the first the default, and a
// tainted third Site.
const valid = nodes(
    ['a', 'site-a', { compute: true, default: true }],
    ['a2', 'site-a', { compute: true, default: true }],
    ['b', 'site-b', { compute: true }],
    ['c', 'site-c', { tainted: true }],
);

test('check_sites passes a labelled multi-node layout and changes nothing', () => {
    const { status, stdout, stderr, log } = checkSites('multi-node', { NODES_JSON_STUB: valid });
    assert.equal(status, 0, stderr);
    assert.equal(stdout.trim(), 'Sites: site-a site-b site-c; compute Sites: site-a site-b; default Site: site-a');
    assert.equal(log, '', 'no label or annotate call');
});

test('check_sites passes three compute Sites and no other', () => {
    const { status, stderr } = checkSites('multi-node', {
        NODES_JSON_STUB: nodes(['a', 'site-a', { compute: true }], ['b', 'site-b', { compute: true, default: true }], ['c', 'site-c', { compute: true }]),
    });
    assert.equal(status, 0, stderr);
});

test('check_sites refuses each broken multi-node layout with the command that fixes it', () => {
    const a = ['a', 'site-a', { compute: true, default: true }];
    const b = ['b', 'site-b', { compute: true }];
    const c = ['c', 'site-c', { tainted: true }];
    const cases = [
        [nodes(a, b, c, ['d', null, { tainted: true }]), /node d has no Site: kubectl label node d topology.kubernetes.io\/zone=<Site id>/],
        [nodes(a, ['a2', 'site-a', { default: true }], b, c), /only some nodes of site-a are labelled openupstream.io\/compute-site=true: kubectl label nodes -l topology.kubernetes.io\/zone=site-a openupstream.io\/compute-site=true/],
        [nodes(a, ['a2', 'site-a', { compute: true }], b, c), /only some nodes of site-a are labelled openupstream.io\/default-site=true: kubectl label nodes -l topology.kubernetes.io\/zone=site-a openupstream.io\/default-site=true/],
        [nodes(a, ['b', 'site-b', { tainted: true }], c), /at least two compute Sites.*kubectl label nodes -l topology.kubernetes.io\/zone=<Site> openupstream.io\/compute-site=true/],
        [nodes(a, b), /at least three Sites/],
        [nodes(a, b, ['c', 'site-c']), /node c is in no compute Site but lacks the taint: kubectl taint node c openupstream.io\/third-site=true:NoSchedule/],
        [nodes(a, ['b', 'site-b', { compute: true, tainted: true }], c), /node b is in the compute Site site-b but carries the taint openupstream.io\/third-site: kubectl taint node b openupstream.io\/third-site-/],
        [nodes(['a', 'site-a', { compute: true }], b, c), /no default Site: kubectl label nodes -l topology.kubernetes.io\/zone=site-a openupstream.io\/default-site=true/],
        [nodes(a, ['b', 'site-b', { compute: true, default: true }], c), /more than one default Site \(site-a site-b\): keep one, e.g. kubectl label nodes -l topology.kubernetes.io\/zone=site-b openupstream.io\/default-site-/],
        [nodes(['a', 'site-a', { compute: true }], b, ['c', 'site-c', { tainted: true, default: true }]), /the default Site site-c is no compute Site: kubectl label nodes -l topology.kubernetes.io\/zone=site-c openupstream.io\/default-site-/],
    ];
    for (const [json, message] of cases) {
        const { status, stderr, log } = checkSites('multi-node', { NODES_JSON_STUB: json });
        assert.notEqual(status, 0, json);
        assert.match(stderr, /Site labels need fixing/);
        assert.match(stderr, message);
        assert.equal(log, '', 'changes nothing');
    }
    const unreachable = checkSites('multi-node', { KUBECTL_FAIL: '1' });
    assert.notEqual(unreachable.status, 0);
    assert.match(unreachable.stderr, /cannot read the nodes/);
});

test('check_sites passes one node labelled compute and default, and refuses anything else', () => {
    const ok = checkSites('single-node', { NODES_JSON_STUB: nodes(['mini', 'home', { compute: true, default: true }]) });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(ok.stdout.trim(), 'Sites: home; compute Sites: home; default Site: home');
    assert.equal(ok.log, '');
    const cases = [
        [nodes(['mini', 'home']), /node mini is not labelled as the compute and default Site: kubectl label node mini openupstream.io\/compute-site=true openupstream.io\/default-site=true/],
        [nodes(['mini', 'home', { compute: true }]), /kubectl label node mini openupstream.io\/compute-site=true openupstream.io\/default-site=true/],
        [nodes(['mini', null, { compute: true, default: true }]), /node mini has no Site: kubectl label node mini topology.kubernetes.io\/zone=<Site id>/],
        [nodes(['a', 's', { compute: true, default: true }], ['b', 's', { compute: true, default: true }]), /the cluster has 2 nodes; install-single-node.sh needs exactly one/],
    ];
    for (const [json, message] of cases) {
        const { status, stderr, log } = checkSites('single-node', { NODES_JSON_STUB: json });
        assert.notEqual(status, 0, json);
        assert.match(stderr, message);
        assert.equal(log, '');
    }
});

test('install-multi-node.sh refuses a cluster with too few Sites before it records a layout', () => {
    const { status, stderr, log } = run('./install-multi-node.sh', {
        NODES_JSON_STUB: nodes(['a', 'site-a', { compute: true }], ['b', 'site-b', { compute: true }]),
    });
    assert.notEqual(status, 0);
    assert.match(stderr, /at least three Sites/);
    assert.match(stderr, /no default Site: kubectl label nodes/);
    assert.equal(log, '', 'records no layout');
});

test('install-single-node.sh refuses anything but one node with gVisor, and missing domains', () => {
    const domains = { PLATFORM_DOMAIN: 'a.example.com', CUSTOMER_DOMAIN: 'b.example.app' };
    const three = run('./install-single-node.sh', { NODES_JSON_STUB: nodes(['a', 's'], ['b', 's'], ['c', 's']), ...domains });
    assert.match(three.stderr, /has 3 nodes/);
    const unlabelled = run('./install-single-node.sh', { NODES_JSON_STUB: nodes(['a', 's', { compute: true, default: true }]), LABELED_STUB: '0', ...domains });
    assert.match(unlabelled.stderr, /openupstream.io\/gvisor=true/);
    const noDomain = run('./install-single-node.sh', { NODES_JSON_STUB: nodes(['a', 's', { compute: true, default: true }]) });
    assert.match(noDomain.stderr, /set PLATFORM_DOMAIN/);
    for (const result of [three, unlabelled, noDomain]) {
        assert.notEqual(result.status, 0);
        assert.equal(result.log, '', 'records no layout');
    }
});

const puts = (log) =>
    log
        .split('\n')
        .filter((line) => line.startsWith('PUT '))
        .map((line) => JSON.parse(line.slice(4)));

test('dns.sh puts names inside a zone and points them at the single node\'s IPv4 address, unchecked', () => {
    const env = { LAYOUT_STUB: 'single-node', NODES_JSON_STUB: singleNodeJson, DNS_DOMAIN: 'home.dev.example.com' };
    const platform = run('./dns.sh', env);
    assert.equal(platform.status, 0, platform.stderr);
    assert.deepEqual(puts(platform.log), [
        { Type: 0, Name: 'home', Value: '192.168.1.50', Ttl: 60, MonitorType: 0 },
    ]);
    // The stale `home` record goes; someone else's `other` stays.
    assert.match(platform.log, /^DELETE 1$/m);
    assert.doesNotMatch(platform.log, /^DELETE [23]$/m);
    const customer = run('./dns.sh', { ...env, DNS_NAMES: '* *.s3' });
    assert.deepEqual(
        puts(customer.log).map((record) => record.Name),
        ['*.home', '*.s3.home'],
    );
});

test('dns.sh points a zone apex at every compute node\'s ExternalIP, health-checked', () => {
    const { status, stderr, log } = run('./dns.sh', {
        LAYOUT_STUB: 'multi-node',
        NODES_JSON_STUB: multiNodeJson,
        DNS_DOMAIN: 'dev.example.com',
    });
    assert.equal(status, 0, stderr);
    assert.deepEqual(
        puts(log).map(({ Name, Value, MonitorType }) => [Name, Value, MonitorType]),
        [
            ['', '203.0.113.0', 2],
            ['', '203.0.113.1', 2],
        ],
    );
});

test('dns.sh leaves multi-node records at private addresses unchecked', () => {
    const homeJson = JSON.stringify({
        items: [
            ['home-a', '192.168.178.31'],
            ['home-b', '100.101.1.2'],
        ].map(([site, address]) => ({
            metadata: { labels: computeLabels(site) },
            status: { addresses: [{ type: 'InternalIP', address }] },
        })),
    });
    const { status, stderr, log } = run('./dns.sh', {
        LAYOUT_STUB: 'multi-node',
        NODES_JSON_STUB: homeJson,
        DNS_DOMAIN: 'dev.example.com',
    });
    assert.equal(status, 0, stderr);
    assert.deepEqual(
        puts(log).map(({ Value, MonitorType }) => [Value, MonitorType]),
        [
            ['192.168.178.31', 0],
            ['100.101.1.2', 0],
        ],
    );
});

test('dns.sh replaces a record whose address is right but whose health check is not', () => {
    const { status, stderr, log } = run('./dns.sh', {
        LAYOUT_STUB: 'multi-node',
        NODES_JSON_STUB: multiNodeJson,
        DNS_DOMAIN: 'pub.dev.example.com',
    });
    assert.equal(status, 0, stderr);
    assert.deepEqual(
        puts(log).map(({ Value, MonitorType }) => [Value, MonitorType]),
        [
            ['203.0.113.0', 2],
            ['203.0.113.1', 2],
        ],
    );
    assert.match(log, /^DELETE 4$/m);
});

test('dns.sh keeps a record with the same address and health check', () => {
    const { status, stderr, log } = run('./dns.sh', {
        LAYOUT_STUB: 'single-node',
        NODES_JSON_STUB: singleNodeJson.replace('192.168.1.50', '10.0.0.9'),
        DNS_DOMAIN: 'home.dev.example.com',
    });
    assert.equal(status, 0, stderr);
    assert.deepEqual(puts(log), []);
    assert.doesNotMatch(log, /DELETE/);
});

test('dns.sh --delete removes only its own names, the former api record included, and needs no cluster', () => {
    const { status, log } = run('./dns.sh --delete', { DNS_DOMAIN: 'home.dev.example.com', KUBECTL_FAIL: '1' });
    assert.equal(status, 0);
    assert.equal(log.trim(), 'DELETE 1\nDELETE 3');
});

test('dns.sh fails for a domain in no bunny.net zone', () => {
    const { status, stderr } = run('./dns.sh', { DNS_DOMAIN: 'a.b.example.org', LAYOUT_STUB: 'multi-node' });
    assert.notEqual(status, 0);
    assert.match(stderr, /no bunny.net zone for a.b.example.org/);
});

const k3s = (env) => {
    const state = mkdtempSync(join(tmpdir(), 'dev-cluster-state-'));
    const result = run('./k3s-single-node.sh root@mini', { STATE: state, ...env });
    return { ...result, kubeconfig: readFileSync(join(state, 'kubeconfig'), 'utf8') };
};

test('k3s-single-node.sh installs gVisor before k3s, labelled as the compute and default Site hetzner-fsn1, with the kubeconfig on the resolved host', () => {
    const { status, stderr, log, kubeconfig } = k3s({ SSH_HOSTNAME_STUB: 'mini.tailnet.ts.net' });
    assert.equal(status, 0, stderr);
    const lines = log.split('\n');
    const gvisor = lines.findIndex((line) => line.endsWith('bash -s'));
    const install = lines.findIndex((line) => line.includes('get.k3s.io'));
    assert.ok(gvisor >= 0 && install > gvisor, log);
    assert.match(lines[install], /--node-label topology.kubernetes.io\/zone=hetzner-fsn1/);
    assert.match(lines[install], /--node-label openupstream.io\/compute-site=true/);
    assert.match(lines[install], /--node-label openupstream.io\/default-site=true/);
    assert.match(lines[install], /--node-label openupstream.io\/gvisor=true/);
    assert.match(lines[install], /--tls-san mini.tailnet.ts.net/);
    assert.doesNotMatch(lines[install], /--node-external-ip/);
    // As root, nothing goes through sudo.
    assert.doesNotMatch(log, /sudo/);
    assert.match(kubeconfig, /server: https:\/\/mini.tailnet.ts.net:6443/);
    assert.match(kubeconfig, /name: oup-single-node/);
    assert.match(log, /applied apply -f ..\/gvisor\/runtimeclass.yaml/);
});

test('k3s-single-node.sh takes the Site id from SITE and its description from SITE_DESCRIPTION, and refuses an id that is no label value', () => {
    const home = k3s({ SITE: 'home', SITE_DESCRIPTION: 'Home mini PC' });
    assert.equal(home.status, 0, home.stderr);
    assert.match(home.log, /get\.k3s\.io.*--node-label topology.kubernetes.io\/zone=home /s);
    assert.match(home.log, /^annotate node --all --overwrite openupstream.io\/site-description=Home mini PC$/m);
    assert.doesNotMatch(k3s({}).log, /annotate/);
    const state = mkdtempSync(join(tmpdir(), 'dev-cluster-state-'));
    const invalid = run('./k3s-single-node.sh root@mini', { STATE: state, SITE: 'my home' });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /SITE must be a label value/);
    assert.equal(invalid.log, '');
});

test('k3s-single-node.sh gives NODE_ADDRESS to k3s as the ExternalIP, the address DNS points at', () => {
    const { status, log } = k3s({ NODE_ADDRESS: '100.101.102.103' });
    assert.equal(status, 0);
    assert.match(log, /get\.k3s\.io.*--node-external-ip 100\.101\.102\.103/s);
});

test('k3s-single-node.sh installs nothing on a machine that has k3s, unless REINSTALL=1', () => {
    const again = k3s({ K3S_INSTALLED_STUB: '1' });
    assert.equal(again.status, 0);
    assert.doesNotMatch(again.log, /bash -s|get\.k3s\.io/);
    assert.match(again.kubeconfig, /server: https:\/\/mini:6443/);
    const reinstall = k3s({ K3S_INSTALLED_STUB: '1', REINSTALL: '1' });
    assert.match(reinstall.log, /bash -s/);
    assert.match(reinstall.log, /get\.k3s\.io/);
});

test('k3s-single-node.sh installs the AppArmor profile before k3s, on every run, and only where AppArmor is on', () => {
    const first = k3s({});
    const lines = first.log.split('\n');
    const profile = lines.findIndex((line) => line.includes('apparmor_parser -r /etc/apparmor.d/cri-containerd.apparmor.d'));
    const install = lines.findIndex((line) => line.includes('get.k3s.io'));
    assert.ok(profile >= 0 && profile < install, first.log);
    assert.match(first.log, /^profile: [1-9]/m, 'the profile file was piped in');
    const again = k3s({ K3S_INSTALLED_STUB: '1' });
    assert.match(again.log, /apparmor_parser -r/);
    const none = k3s({ APPARMOR_STUB: '0' });
    assert.equal(none.status, 0);
    assert.doesNotMatch(none.log, /apparmor_parser/);
});

test('the DatabaseConfig carries the layout, and a single node stores Databases on local-path', () => {
    const config = (layout) => {
        const { status, stdout, stderr } = run('set -euo pipefail; source ./lib.sh; load_layout; database_config', { LAYOUT_STUB: layout, CLUSTER_ID_STUB: 'c1' });
        assert.equal(status, 0, stderr);
        return JSON.parse(stdout);
    };
    const original = JSON.parse(readFileSync(join(here, 'database-config.json'), 'utf8'));
    const backup = { ...original.backup, prefix: 'c1' };
    assert.deepEqual(config('multi-node'), { ...original, backup, layout: 'multi-node' });
    assert.deepEqual(config('single-node'), { ...original, backup, layout: 'single-node', storageClass: 'local-path' });
});

test('k3s-single-node.sh refuses a NODE_ADDRESS that an installed k3s does not have, unless REINSTALL=1', () => {
    const state = mkdtempSync(join(tmpdir(), 'dev-cluster-state-'));
    const other = run('./k3s-single-node.sh root@mini', {
        STATE: state, K3S_INSTALLED_STUB: '1', EXTERNAL_IP_STUB: '192.168.1.50', NODE_ADDRESS: '100.101.102.103',
    });
    assert.notEqual(other.status, 0);
    assert.match(other.stderr, /ExternalIP is '192\.168\.1\.50', not 100\.101\.102\.103/);
    assert.doesNotMatch(other.log, /get\.k3s\.io/);
    const same = k3s({ K3S_INSTALLED_STUB: '1', EXTERNAL_IP_STUB: '100.101.102.103', NODE_ADDRESS: '100.101.102.103' });
    assert.equal(same.status, 0);
    const reinstall = k3s({ K3S_INSTALLED_STUB: '1', EXTERNAL_IP_STUB: '192.168.1.50', NODE_ADDRESS: '100.101.102.103', REINSTALL: '1' });
    assert.match(reinstall.log, /get\.k3s\.io.*--node-external-ip 100\.101\.102\.103/s);
});

test('S3 requests from Traefik go to nginx in the Garage pods, which gives a request without a body its Content-Length', () => {
    const garage = readFileSync(join(here, '..', 'garage', 'garage.yaml'), 'utf8');
    const route = readFileSync(join(here, '..', 'garage', 's3-route.yaml'), 'utf8');
    // Every rule of the route, and no rule to Garage's own port.
    const targets = [...route.matchAll(/services: \[\{name: garage, port: (\d+)/g)].map((match) => match[1]);
    assert.deepEqual(targets, ['3905', '3905']);
    // That port is nginx: on the Service, on the container, and what nginx listens on.
    assert.match(garage, /\{name: s3-public, port: 3905, targetPort: s3-public\}/);
    assert.match(garage, /\{name: s3-public, containerPort: 3905\}/);
    assert.match(garage, /listen \[::\]:3905 /);
    assert.match(garage, /server 127\.0\.0\.1:3900;/);
    // Neither a length nor a transfer encoding: 0. Otherwise what came, which is nothing for a chunked body.
    assert.match(garage, /map "\$http_content_length\$http_transfer_encoding" \$garage_content_length \{\s+"" +0;\s+default \$http_content_length;\s+\}/);
    assert.match(garage, /proxy_set_header Content-Length \$garage_content_length;/);
    // A signature covers the Host and the URI as the client sent them, and a body is not held back.
    assert.match(garage, /proxy_set_header Host \$http_host;/);
    assert.match(garage, /proxy_pass http:\/\/garage;/);
    assert.match(garage, /proxy_request_buffering off;/);
});
