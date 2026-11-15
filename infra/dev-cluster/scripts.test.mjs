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
  "GET https://api.bunny.net/dnszone/7") echo '{"Records":[{"Id":1,"Type":0,"Name":"home","Value":"10.0.0.9"},{"Id":2,"Type":0,"Name":"other","Value":"1.1.1.1"}]}' ;;
  PUT*) echo "PUT $(jq -c . <<<"$body")" >>"$STUB_LOG"; echo '{}' ;;
  DELETE*) echo "DELETE \${url##*/}" >>"$STUB_LOG" ;;
  *) echo "unexpected: curl $method $url" >&2; exit 9 ;;
esac
`,
);
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
        { Type: 0, Name: 'api.home', Value: '192.168.1.50', Ttl: 60, MonitorType: 0 },
    ]);
    // The stale `home` record goes; someone else's `other` stays.
    assert.match(platform.log, /^DELETE 1$/m);
    assert.doesNotMatch(platform.log, /^DELETE 2$/m);
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
            ['api', '203.0.113.0', 2],
            ['', '203.0.113.1', 2],
            ['api', '203.0.113.1', 2],
        ],
    );
});

test('dns.sh --delete removes only its own names and needs no cluster', () => {
    const { status, log } = run('./dns.sh --delete', { DNS_DOMAIN: 'home.dev.example.com', KUBECTL_FAIL: '1' });
    assert.equal(status, 0);
    assert.equal(log.trim(), 'DELETE 1');
});

test('dns.sh fails for a domain in no bunny.net zone', () => {
    const { status, stderr } = run('./dns.sh', { DNS_DOMAIN: 'a.b.example.org', LAYOUT_STUB: 'multi-node' });
    assert.notEqual(status, 0);
    assert.match(stderr, /no bunny.net zone for a.b.example.org/);
});
