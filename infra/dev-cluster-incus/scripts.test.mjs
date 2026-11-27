// Tests for the Incus dev cluster scripts' own logic (ARCHITECTURE.md,
// decision 137): instance names with and without a remote, the VM address
// picked from the Incus API, and snapshot.sh's order of work. incus is a
// stub on PATH; nothing reaches an Incus host. Run by `npm test` at the
// repository root; needs bash and jq.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const stubs = mkdtempSync(join(tmpdir(), 'dev-cluster-incus-stubs-'));

// incus: every call goes to $STUB_LOG; `snapshot show` and `storage volume
// snapshot show` fail for the names in MISSING_STUB; a call containing
// FAIL_STUB fails.
writeFileSync(
    join(stubs, 'incus'),
    `#!/usr/bin/env bash
echo "incus $*" >>"$STUB_LOG"
case "$*" in
  "snapshot show "* | "storage volume snapshot show "*)
    for missing in \${MISSING_STUB:-}; do [[ " $* " == *" $missing "* ]] && exit 1; done ;;
esac
[[ -n \${FAIL_STUB:-} && "$*" == *"$FAIL_STUB"* ]] && exit 1
exit 0
`,
);
chmodSync(join(stubs, 'incus'), 0o755);
// kubectl: every call goes to $STUB_LOG; there is one Database, no Postgres
// pod is left, and the API is ready.
writeFileSync(
    join(stubs, 'kubectl'),
    `#!/usr/bin/env bash
echo "kubectl $*" >>"$STUB_LOG"
case "$*" in
  "get clusters.postgresql.cnpg.io -A -o name") echo cluster.postgresql.cnpg.io/db-1 ;;
esac
exit 0
`,
);
chmodSync(join(stubs, 'kubectl'), 0o755);
const kubeconfig = join(stubs, 'kubeconfig');
writeFileSync(kubeconfig, '');
const noKubeconfig = join(stubs, 'missing-kubeconfig');

const run = (command, env = {}) => {
    const log = join(mkdtempSync(join(tmpdir(), 'dev-cluster-incus-log-')), 'log');
    writeFileSync(log, '');
    const result = spawnSync('bash', ['-c', command], {
        cwd: here,
        encoding: 'utf8',
        env: { PATH: `${stubs}:${process.env.PATH}`, HOME: process.env.HOME, STUB_LOG: log, KUBECONFIG: noKubeconfig, ...env },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, log: readFileSync(log, 'utf8') };
};

test('instance names carry the remote only when INCUS_REMOTE is set', () => {
    const names = 'source ./lib.sh; instance hetzner-fsn1; volume_name ovh-lim';
    assert.equal(run(names).stdout, 'oup-home-hetzner-fsn1\noup-home-ovh-lim-lvm\n');
    assert.equal(run(names, { INCUS_REMOTE: 'mini' }).stdout, 'mini:oup-home-hetzner-fsn1\noup-home-ovh-lim-lvm\n');
});

test('vm_ipv4 picks the global IPv4 address of the home network interface, not k3s\'s', () => {
    const state = {
        network: {
            lo: { addresses: [{ family: 'inet', address: '127.0.0.1', scope: 'local' }] },
            cni0: { addresses: [{ family: 'inet', address: '10.42.0.1', scope: 'global' }] },
            'flannel-wg': { addresses: [{ family: 'inet', address: '10.42.0.0', scope: 'global' }] },
            enp5s0: {
                addresses: [
                    { family: 'inet6', address: 'fe80::1', scope: 'link' },
                    { family: 'inet', address: '192.168.178.31', scope: 'global' },
                ],
            },
        },
    };
    const pick = (json) => run(`source ./lib.sh; vm_ipv4 <<<'${JSON.stringify(json)}'`).stdout;
    assert.equal(pick(state), '192.168.178.31\n');
    assert.equal(pick({ network: null }), '', 'nothing before the agent reports');
});

const calls = (log) =>
    log
        .trim()
        .split('\n')
        .filter((line) => line.startsWith('incus '))
        .map((line) => line.replace(/^incus /, ''));

test('snapshot.sh create stops all three VMs, snapshots them and the volumes, then starts them', () => {
    const { status, stderr, log } = run('./snapshot.sh create before-upgrade');
    assert.equal(status, 0, stderr);
    // The stops run in parallel, so in any order, but all before the snapshots.
    assert.deepEqual(calls(log).slice(0, 3).sort(), [
        'stop oup-home-hetzner-fsn1',
        'stop oup-home-netcup-nbg',
        'stop oup-home-ovh-lim',
    ]);
    assert.deepEqual(calls(log).slice(3), [
        'snapshot create oup-home-hetzner-fsn1 before-upgrade',
        'snapshot create oup-home-ovh-lim before-upgrade',
        'snapshot create oup-home-netcup-nbg before-upgrade',
        'storage volume snapshot create default oup-home-hetzner-fsn1-lvm before-upgrade',
        'storage volume snapshot create default oup-home-ovh-lim-lvm before-upgrade',
        'start oup-home-hetzner-fsn1',
        'start oup-home-ovh-lim',
        'start oup-home-netcup-nbg',
    ]);
});

test('snapshot.sh create hibernates the Databases before stopping and wakes them after starting', () => {
    const { status, stderr, log } = run('./snapshot.sh create x', { KUBECONFIG: kubeconfig });
    assert.equal(status, 0, stderr);
    const lines = log.trim().split('\n');
    const at = (text) => lines.findIndex((line) => line.includes(text));
    assert.ok(at('cnpg.io/hibernation=on') >= 0, log);
    assert.ok(at('cnpg.io/hibernation=on') < at('incus stop'), 'hibernated before the first stop');
    assert.ok(at('podRole=instance') < at('incus stop'), 'waited for Postgres to stop');
    assert.ok(at('incus start oup-home-netcup-nbg') < at('get --raw /readyz'), 'waits for the API after starting');
    assert.ok(at('get --raw /readyz') < at('cnpg.io/hibernation=off'), 'wakes after the API is back');
});

test('snapshot.sh restore wakes the Databases the snapshot holds hibernated', () => {
    const { status, stderr, log } = run('./snapshot.sh restore x', { KUBECONFIG: kubeconfig });
    assert.equal(status, 0, stderr);
    assert.doesNotMatch(log, /hibernation=on/);
    assert.match(log.trim().split('\n').at(-1), /cnpg.io\/hibernation=off/);
});

test('snapshot.sh wakes the Databases again when a snapshot fails', () => {
    const { status, log } = run('./snapshot.sh create x', { KUBECONFIG: kubeconfig, FAIL_STUB: 'volume snapshot create' });
    assert.notEqual(status, 0);
    assert.match(log.trim().split('\n').at(-1), /cnpg.io\/hibernation=off/);
});

test('snapshot.sh restore stops nothing when a VM or volume lacks the snapshot', () => {
    const { status, stderr, log } = run('./snapshot.sh restore before-upgrade', {
        MISSING_STUB: 'oup-home-ovh-lim-lvm',
    });
    assert.notEqual(status, 0);
    assert.match(stderr, /volume oup-home-ovh-lim-lvm has no snapshot before-upgrade/);
    assert.ok(!calls(log).some((call) => call.startsWith('stop') || call.includes('restore')), log);
});

test('snapshot.sh restore uses the remote for VMs and pool', () => {
    const { status, stderr, log } = run('./snapshot.sh restore x', { INCUS_REMOTE: 'mini' });
    assert.equal(status, 0, stderr);
    assert.ok(calls(log).includes('snapshot restore mini:oup-home-netcup-nbg x'), log);
    assert.ok(calls(log).includes('storage volume snapshot restore mini:default oup-home-hetzner-fsn1-lvm x'), log);
});

test('snapshot.sh refuses a name incus would not take, before stopping anything', () => {
    const { status, log } = run("./snapshot.sh create 'a b'");
    assert.equal(status, 2);
    assert.equal(log, '');
});

test('snapshot.sh starts the VMs again when a snapshot fails', () => {
    const { status, stderr, log } = run('./snapshot.sh create x', { FAIL_STUB: 'volume snapshot create' });
    assert.notEqual(status, 0);
    assert.match(stderr, /create failed; starting the VMs again/);
    assert.deepEqual(calls(log).slice(-3), [
        'start oup-home-hetzner-fsn1',
        'start oup-home-ovh-lim',
        'start oup-home-netcup-nbg',
    ]);
});

test('down.sh refuses to run without the install\'s domains, before deleting anything', () => {
    const { status, stderr, log } = run('YES=1 ./down.sh', { STATE: mkdtempSync(join(tmpdir(), 'dev-cluster-incus-state-')) });
    assert.equal(status, 1);
    assert.match(stderr, /set PLATFORM_DOMAIN and CUSTOMER_DOMAIN/);
    assert.equal(log, '');
});

test('down.sh with SKIP_DNS deletes the VMs and the compute volumes', () => {
    const { status, stderr, log } = run('YES=1 SKIP_DNS=1 ./down.sh', { STATE: mkdtempSync(join(tmpdir(), 'dev-cluster-incus-state-')) });
    assert.equal(status, 0, stderr);
    assert.ok(calls(log).includes('delete --force oup-home-netcup-nbg'), log);
    assert.ok(calls(log).includes('storage volume delete default oup-home-ovh-lim-lvm'), log);
    assert.ok(!calls(log).some((call) => call.includes('netcup-nbg-lvm')), log);
});
