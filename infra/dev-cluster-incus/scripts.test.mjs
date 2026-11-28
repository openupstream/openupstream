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
  "query "*) printf '{"status":"%s"}\\n' "\${STATUS_STUB:-Stopped}" ;;
  "snapshot show "* | "storage volume snapshot show "*)
    for missing in \${MISSING_STUB:-}; do [[ " $* " == *" $missing "* ]] && exit 1; done ;;
esac
[[ -n \${FAIL_STUB:-} && "$*" == *"$FAIL_STUB"* ]] && exit 1
exit 0
`,
);
chmodSync(join(stubs, 'incus'), 0o755);
// kubectl: every call goes to $STUB_LOG; there are two Databases, db-2
// hibernated on purpose, db-1 marked as hibernated by snapshot.sh once it
// is; no Postgres pod is left, and the API is ready.
writeFileSync(
    join(stubs, 'kubectl'),
    `#!/usr/bin/env bash
echo "kubectl $*" >>"$STUB_LOG"
case "$*" in
  "get clusters.postgresql.cnpg.io -A -o name") echo cluster.postgresql.cnpg.io/db-1 ;;
  "get clusters.postgresql.cnpg.io -A -o json")
    echo '{"items":[{"metadata":{"namespace":"p","name":"db-1"}},{"metadata":{"namespace":"p","name":"db-2","annotations":{"cnpg.io/hibernation":"on"}}}]}' ;;
  "get clusters.postgresql.cnpg.io -A -l openupstream.io/snapshot-hibernated -o name") echo cluster.postgresql.cnpg.io/db-1 ;;
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

test('SITES chooses the VMs\' Site ids, the third one without a volume', () => {
    const sites = 'source ./lib.sh; echo "${SITES[*]} / $THIRD_SITE"';
    assert.equal(run(sites).stdout, 'hetzner-fsn1 ovh-lim netcup-nbg / netcup-nbg\n');
    assert.equal(run(sites, { SITES: 'home-a home-b home-c' }).stdout, 'home-a home-b home-c / home-c\n');
    const { log } = run('YES=1 SKIP_DNS=1 ./down.sh', { SITES: 'home-a home-b home-c', STATE: mkdtempSync(join(tmpdir(), 'incus-state-')) });
    assert.match(log, /incus delete --force oup-home-home-c/);
    assert.match(log, /storage volume delete default oup-home-home-b-lvm/);
    assert.doesNotMatch(log, /home-c-lvm/);
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
        .filter((line) => line.startsWith('incus ') && !line.startsWith('incus query '))
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

test('snapshot.sh hibernates and wakes only the Databases it marks, not one hibernated on purpose', () => {
    const { status, stderr, log } = run('./snapshot.sh create x', { KUBECONFIG: kubeconfig });
    assert.equal(status, 0, stderr);
    assert.match(log, /-n p label clusters.postgresql.cnpg.io db-1 openupstream.io\/snapshot-hibernated=true/);
    assert.doesNotMatch(log, /db-2/);
    assert.match(log, /annotate clusters.postgresql.cnpg.io -A -l openupstream.io\/snapshot-hibernated cnpg.io\/hibernation=off/);
    assert.match(log.trim().split('\n').at(-1), /label clusters.postgresql.cnpg.io -A -l openupstream.io\/snapshot-hibernated openupstream.io\/snapshot-hibernated-/);
});

test('snapshot.sh restore hibernates before stopping and wakes the restored Databases', () => {
    const { status, stderr, log } = run('./snapshot.sh restore x', { KUBECONFIG: kubeconfig });
    assert.equal(status, 0, stderr);
    const lines = log.trim().split('\n');
    const at = (text) => lines.findIndex((line) => line.includes(text));
    assert.ok(at('hibernation=on') < at('incus stop'), log);
    assert.ok(at('incus snapshot restore') < at('hibernation=off'), log);
});

test('snapshot.sh wakes the Databases again when a snapshot fails', () => {
    const { status, log } = run('./snapshot.sh create x', { KUBECONFIG: kubeconfig, FAIL_STUB: 'volume snapshot create' });
    assert.notEqual(status, 0);
    const lines = log.trim().split('\n');
    const at = (text) => lines.findIndex((line) => line.includes(text));
    assert.ok(at('volume snapshot create') < at('hibernation=off'), log);
});

test('snapshot.sh starts the VMs and wakes the Databases when a wait gives up', () => {
    // A wait that gives up exits; the EXIT trap must still recover.
    const { status, stderr, log } = run('./snapshot.sh create x', { KUBECONFIG: kubeconfig, STATUS_STUB: 'Running' });
    assert.notEqual(status, 0);
    assert.match(stderr, /did not stop/);
    assert.match(log, /incus start oup-home-netcup-nbg/);
    assert.match(log, /hibernation=off/);
});

test('snapshot.sh says nothing about recovering when restore stops before touching anything', () => {
    const { stderr } = run('./snapshot.sh restore x', { MISSING_STUB: 'oup-home-hetzner-fsn1' });
    assert.doesNotMatch(stderr, /starting the VMs/);
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
    assert.match(stderr, /create failed; starting the VMs and waking the Databases again/);
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
