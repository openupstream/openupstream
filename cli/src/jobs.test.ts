import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { JobDetails, JobRun } from '@openupstream/sdk';
import { DEFAULTS, formatJobs, formatRuns, isFinished, outcomeOf, parseEnv, planJobDeploy, splitAtDashes, strayFlag } from './jobs.js';
import { waitUntil } from './wait.js';

const existing: JobDetails = {
    id: '55555555-5555-4555-8555-555555555555',
    projectId: '11111111-1111-4111-8111-111111111111',
    name: 'nightly',
    image: 'ghcr.io/acme/api:v1',
    imageDigest: `sha256:${'a'.repeat(64)}`,
    deployedAt: '2026-11-01T00:00:00Z',
    command: ['node', 'dist/nightly.js'],
    args: null,
    memoryMb: 256,
    cpuMillicores: 250,
    timeoutSeconds: 3600,
    schedule: '0 3 * * *',
    timeZone: 'Europe/Berlin',
    homeSite: null,
    registryAuth: false,
    createdAt: '2026-11-01T00:00:00Z',
    state: 'ready',
};

test('a new Job is created with the defaults for what the flags leave out, unscheduled unless told', () => {
    assert.deepEqual(planJobDeploy(undefined, { name: 'once', image: 'nginx' }), {
        kind: 'create',
        input: { name: 'once', image: 'nginx', memoryMb: DEFAULTS.memoryMb, cpuMillicores: DEFAULTS.cpuMillicores },
    });
    const scheduled = planJobDeploy(undefined, { name: 'n', image: 'nginx', schedule: '@daily', timeZone: 'UTC', command: ['sh', '-c', 'date'] });
    assert.equal(scheduled.kind, 'create');
    assert.deepEqual(scheduled.kind === 'create' && [scheduled.input.schedule, scheduled.input.timeZone, scheduled.input.command], [
        '@daily',
        'UTC',
        ['sh', '-c', 'date'],
    ]);
});

test('the same flags deploy the tag again; a difference becomes a change that resolves the tag too', () => {
    assert.deepEqual(planJobDeploy(existing, { name: 'nightly', image: existing.image, command: ['node', 'dist/nightly.js'], schedule: '0 3 * * *' }), {
        kind: 'redeploy',
        jobId: existing.id,
    });
    assert.deepEqual(planJobDeploy(existing, { name: 'nightly', image: existing.image, schedule: '0 4 * * *', timeoutSeconds: 3600 }), {
        kind: 'update',
        jobId: existing.id,
        patch: { schedule: '0 4 * * *', image: existing.image },
    });
    assert.deepEqual(planJobDeploy(existing, { name: 'nightly', image: existing.image, schedule: null, command: ['node', 'other.js'] }), {
        kind: 'update',
        jobId: existing.id,
        patch: { command: ['node', 'other.js'], schedule: null, image: existing.image },
    });
    const auth = { username: 'ci', password: 'token' };
    assert.deepEqual(planJobDeploy(existing, { name: 'nightly', image: existing.image, registryAuth: auth }), {
        kind: 'update',
        jobId: existing.id,
        patch: { image: existing.image, registryAuth: auth },
    });
});

test('--env takes NAME=value, the value may hold =', () => {
    assert.deepEqual(parseEnv(['ORDER_ID=42', 'QUERY=a=b', 'EMPTY=']), { ok: true, value: { ORDER_ID: '42', QUERY: 'a=b', EMPTY: '' } });
    assert.equal(parseEnv(['=x']).ok, false);
    assert.equal(parseEnv(['NOVALUE']).ok, false);
});

test('what follows -- is never a flag', () => {
    assert.deepEqual(splitAtDashes(['nightly', '--image', 'x', '--', 'node', '--max-old-space-size=512', 'a.js']), {
        flags: ['nightly', '--image', 'x'],
        rest: ['node', '--max-old-space-size=512', 'a.js'],
    });
    assert.deepEqual(splitAtDashes(['nightly']), { flags: ['nightly'], rest: undefined });
    assert.deepEqual(splitAtDashes(['nightly', '--']), { flags: ['nightly'], rest: [] });
});

const run = (overrides: Partial<JobRun> = {}): JobRun => ({
    id: `job-${existing.id}-abc12345`,
    jobId: existing.id,
    trigger: 'api',
    state: 'pending',
    reason: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...overrides,
});

test('runs and Jobs read as one line each', () => {
    assert.equal(outcomeOf(run()), 'pending');
    assert.equal(outcomeOf(run({ state: 'succeeded', startedAt: '2026-11-01T10:00:02.000Z', finishedAt: '2026-11-01T10:00:14.000Z' })), 'succeeded in 12 s');
    assert.equal(
        outcomeOf(run({ state: 'failed', reason: 'DeadlineExceeded', finishedAt: '2026-11-01T11:00:00.000Z' })),
        'failed after 3600 s (DeadlineExceeded)',
    );
    assert.match(formatRuns([run()])[0] ?? '', /^job-.* api {7}2026-11-01T10:00:00.000Z +pending$/);
    assert.match(formatJobs([existing])[0] ?? '', /^nightly +ready +0 3 \* \* \* Europe\/Berlin +ghcr.io\/acme\/api:v1 \(sha256:aaaaaaaaaaaa\)$/);
    assert.match(formatJobs([{ ...existing, schedule: null, timeZone: null }])[0] ?? '', / on demand /);
});

test('a run is waited for until it has finished, either way', async () => {
    const reads: JobRun['state'][] = ['pending', 'running', 'running', 'failed'];
    const reported: string[] = [];
    const done = await waitUntil(async () => ({ ok: true, value: run({ state: reads.shift() ?? 'failed' }) }), isFinished, {
        timeoutMs: 1_000,
        intervalMs: 1,
        report: (state) => reported.push(state),
    });
    assert.equal(done.ok && done.value.state, 'failed');
    assert.deepEqual(reported, ['pending', 'running', 'failed']);
});

test('--no-command goes back to the image entrypoint', () => {
    assert.deepEqual(planJobDeploy(existing, { name: 'nightly', image: existing.image, command: null }), {
        kind: 'update',
        jobId: existing.id,
        patch: { command: null, image: existing.image },
    });
    assert.equal(planJobDeploy(undefined, { name: 'n', image: 'nginx', command: null }).kind, 'create');
});

test("a flag of another verb is refused, not ignored", () => {
    assert.equal(strayFlag('deploy', { image: 'x', env: ['A=1'] }), 'env');
    assert.equal(strayFlag('run', { schedule: '@daily' }), 'schedule');
    assert.equal(strayFlag('run', { env: ['A=1'], 'no-wait': true, project: 'shop' }), undefined);
    assert.equal(strayFlag('list', { project: undefined }), undefined);
});

test('a run that is gone ends the wait at once', async () => {
    let reads = 0;
    const gone = await waitUntil(
        async () => (++reads === 1 ? { ok: true, value: run({ state: 'running' }) } : { ok: false, error: { status: 404, message: 'not found' } }),
        isFinished,
        { timeoutMs: 60_000, intervalMs: 1, report: () => undefined },
    );
    assert.deepEqual(gone, { ok: false, error: 'gone: not found' });
    assert.equal(reads, 2);
});
