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
// snapshot show` fail for the names in MISSING_STUB.
writeFileSync(
    join(stubs, 'incus'),
    `#!/usr/bin/env bash
echo "incus $*" >>"$STUB_LOG"
case "$*" in
  "snapshot show "* | "storage volume snapshot show "*)
    for missing in \${MISSING_STUB:-}; do [[ " $* " == *" $missing "* ]] && exit 1; done ;;
esac
exit 0
`,
);
chmodSync(join(stubs, 'incus'), 0o755);

const run = (command, env = {}) => {
    const log = join(mkdtempSync(join(tmpdir(), 'dev-cluster-incus-log-')), 'log');
    writeFileSync(log, '');
    const result = spawnSync('bash', ['-c', command], {
        cwd: here,
        encoding: 'utf8',
        env: { PATH: `${stubs}:${process.env.PATH}`, HOME: process.env.HOME, STUB_LOG: log, ...env },
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

const calls = (log) => log.trim().split('\n').map((line) => line.replace(/^incus /, ''));

test('snapshot.sh create stops all three VMs, snapshots them and the volumes, then starts them', () => {
    const { status, stderr, log } = run('./snapshot.sh create before-upgrade');
    assert.equal(status, 0, stderr);
    assert.deepEqual(calls(log), [
        'stop oup-home-hetzner-fsn1',
        'stop oup-home-ovh-lim',
        'stop oup-home-netcup-nbg',
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
