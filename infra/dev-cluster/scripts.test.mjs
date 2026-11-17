// Tests for the dev-cluster scripts' own logic (ARCHITECTURE.md, decision
// 109): the recorded layout, the entry scripts' node checks and dns.sh's
// records. kubectl and curl are stubs on PATH; nothing reaches a cluster or
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
// node names from NODES_STUB, nodes per Site from SITES_STUB, the single
// node's labels from LABELED_STUB, nodes as JSON from NODES_JSON_STUB.
// Writes go to $STUB_LOG.
writeFileSync(
    join(stubs, 'kubectl'),
    `#!/usr/bin/env bash
[[ \${KUBECTL_FAIL:-} == 1 ]] && { echo "connection refused" >&2; exit 1; }
args="$*"
case $args in
  *"get configmap cluster-layout"*) printf '%s' "\${LAYOUT_STUB:-}" ;;
  *"create configmap"*) echo "configmap $args" >>"$STUB_LOG"; echo '{}' ;;
  *"create namespace"*) echo '{}' ;;
  "apply -f -") cat >/dev/null ;;
  *"get nodes -o name"*) for n in \${NODES_STUB:-}; do echo "node/$n"; done ;;
  *"get nodes -l topology.kubernetes.io/zone in"*) printf '%s' "$NODES_JSON_STUB" ;;
  *"openupstream.io/gvisor=true"*) [[ \${LABELED_STUB:-1} == 1 ]] && echo node/a ;;
  *"get nodes -l topology.kubernetes.io/zone="*)
    site=\${args#*zone=}; site=\${site%% *}
    [[ " \${SITES_STUB:-} " == *" $site "* ]] && echo "node/$site" ;;
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
  "GET https://api.bunny.net/dnszone/7") echo '{"Records":[{"Id":1,"Type":0,"Name":"home","Value":"10.0.0.9"},{"Id":2,"Type":0,"Name":"other","Value":"1.1.1.1"},{"Id":3,"Type":0,"Name":"api.home","Value":"10.0.0.9"}]}' ;;
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

const singleNodeJson = JSON.stringify({
    items: [
        {
            metadata: { labels: { 'topology.kubernetes.io/zone': 'hetzner-fsn1' } },
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
const multiNodeJson = JSON.stringify({
    items: ['hetzner-fsn1', 'ovh-lim'].map((site, i) => ({
        metadata: { labels: { 'topology.kubernetes.io/zone': site } },
        status: {
            addresses: [
                { type: 'InternalIP', address: `10.0.1.${i}` },
                { type: 'ExternalIP', address: `203.0.113.${i}` },
            ],
        },
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

test('platform.sh with SIGNUP=closed needs a waitlist host other than the platform domain, before it changes anything', () => {
    for (const env of [{}, { WAITLIST_DOMAIN: 'dev.openupstream.com' }]) {
        const { status, stderr, log } = run('./platform.sh', { LAYOUT_STUB: 'multi-node', SIGNUP: 'closed', MAIL: 'log', ...env });
        assert.notEqual(status, 0);
        assert.match(stderr, /SIGNUP=closed needs WAITLIST_DOMAIN.*dev\.openupstream\.com serves the dashboard/);
        assert.equal(log, '');
    }
});

test("platform.sh refuses a WEBSITE_PROJECT_ID that is not a Project's id, before it changes anything", () => {
    for (const id of ['website', '7b0c1c0e-5d0a-4a43-9f3e']) {
        const { status, stderr, log } = run('./platform.sh', { LAYOUT_STUB: 'multi-node', WEBSITE_PROJECT_ID: id });
        assert.notEqual(status, 0);
        assert.match(stderr, /WEBSITE_PROJECT_ID must be the website Project's id/);
        assert.equal(log, '');
    }
});

test('install-multi-node.sh refuses a cluster without a node in every Site', () => {
    for (const sites of ['hetzner-fsn1', 'hetzner-fsn1 ovh-lim']) {
        const { status, stderr, log } = run('./install-multi-node.sh', { SITES_STUB: sites });
        assert.notEqual(status, 0);
        assert.match(stderr, /netcup-nbg/);
        assert.equal(log, '', 'records no layout');
    }
});

test('install-single-node.sh refuses anything but one labelled node, and missing domains', () => {
    const domains = { PLATFORM_DOMAIN: 'a.example.com', CUSTOMER_DOMAIN: 'b.example.app' };
    const three = run('./install-single-node.sh', { NODES_STUB: 'a b c', ...domains });
    assert.match(three.stderr, /has 3 nodes/);
    const unlabelled = run('./install-single-node.sh', { NODES_STUB: 'a', LABELED_STUB: '0', ...domains });
    assert.match(unlabelled.stderr, /topology.kubernetes.io\/zone=hetzner-fsn1/);
    const noDomain = run('./install-single-node.sh', { NODES_STUB: 'a' });
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
            ['hetzner-fsn1', '192.168.178.31'],
            ['ovh-lim', '100.101.1.2'],
        ].map(([site, address]) => ({
            metadata: { labels: { 'topology.kubernetes.io/zone': site } },
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

test('k3s-single-node.sh installs gVisor before k3s, labelled as hetzner-fsn1, with the kubeconfig on the resolved host', () => {
    const { status, stderr, log, kubeconfig } = k3s({ SSH_HOSTNAME_STUB: 'mini.tailnet.ts.net' });
    assert.equal(status, 0, stderr);
    const lines = log.split('\n');
    const gvisor = lines.findIndex((line) => line.endsWith('bash -s'));
    const install = lines.findIndex((line) => line.includes('get.k3s.io'));
    assert.ok(gvisor >= 0 && install > gvisor, log);
    assert.match(lines[install], /--node-label topology.kubernetes.io\/zone=hetzner-fsn1/);
    assert.match(lines[install], /--node-label openupstream.io\/gvisor=true/);
    assert.match(lines[install], /--tls-san mini.tailnet.ts.net/);
    assert.doesNotMatch(lines[install], /--node-external-ip/);
    // As root, nothing goes through sudo.
    assert.doesNotMatch(log, /sudo/);
    assert.match(kubeconfig, /server: https:\/\/mini.tailnet.ts.net:6443/);
    assert.match(kubeconfig, /name: oup-single-node/);
    assert.match(log, /applied apply -f ..\/gvisor\/runtimeclass.yaml/);
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
        const { status, stdout, stderr } = run('set -euo pipefail; source ./lib.sh; load_layout; database_config', { LAYOUT_STUB: layout });
        assert.equal(status, 0, stderr);
        return JSON.parse(stdout);
    };
    const original = JSON.parse(readFileSync(join(here, 'database-config.json'), 'utf8'));
    assert.deepEqual(config('multi-node'), { ...original, layout: 'multi-node' });
    assert.deepEqual(config('single-node'), { ...original, layout: 'single-node', storageClass: 'local-path' });
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
