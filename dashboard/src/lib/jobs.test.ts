import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEW_JOB, formatSeconds, jobFieldsOf, jobInput, jobNameProblem, jobPatch, jobWanted, runDuration, scheduleLabel } from './jobs';

const job = { image: 'ghcr.io/acme/report:v3', schedule: '0 3 * * *', timeZone: 'Europe/Berlin', timeoutSeconds: 600, memoryMb: 256, cpuMillicores: 250, homeSite: null };

test('a Job form: an empty schedule for a Job only started, whole numbers within the limits', () => {
    assert.deepEqual(jobWanted({ ...NEW_JOB, image: ' ghcr.io/acme/report:v3 ' }), {
        image: 'ghcr.io/acme/report:v3',
        schedule: null,
        timeZone: null,
        timeoutSeconds: 3600,
        memoryMb: 256,
        cpuMillicores: 250,
        homeSite: null,
    });
    assert.deepEqual(jobWanted(jobFieldsOf(job)), job);
    assert.deepEqual(jobWanted({ ...jobFieldsOf(job), schedule: ' */15  * * * * ', homeSite: 'ovh-lim' }), { ...job, schedule: '*/15 * * * *', homeSite: 'ovh-lim' });
    assert.deepEqual(jobWanted({ ...jobFieldsOf(job), schedule: '@daily' }), { ...job, schedule: '@daily' });
    assert.match(String(jobWanted(NEW_JOB)), /Enter the image/);
    assert.match(String(jobWanted({ ...jobFieldsOf(job), schedule: '0 3 * *' })), /five fields/);
    assert.match(String(jobWanted({ ...jobFieldsOf(job), schedule: '' })), /time zone is for a schedule/);
    assert.match(String(jobWanted({ ...jobFieldsOf(job), timeoutSeconds: '0' })), /timeout/);
    assert.match(String(jobWanted({ ...jobFieldsOf(job), timeoutSeconds: '86401' })), /timeout/);
    assert.match(String(jobWanted({ ...jobFieldsOf(job), memoryMb: '1.5' })), /Memory/);
    assert.match(String(jobWanted({ ...jobFieldsOf(job), cpuMillicores: '' })), /CPU/);
    assert.match(String(jobWanted({ ...jobFieldsOf(job), homeSite: 'mars' })), /Site/);
});

test('a Job name is a DNS label the Project does not have yet', () => {
    assert.equal(jobNameProblem('nightly-report', [{ name: 'other' }]), undefined);
    assert.equal(jobNameProblem('', []), 'Enter a name.');
    assert.match(jobNameProblem('Nightly', []) ?? '', /Lowercase/);
    assert.equal(jobNameProblem('report', [{ name: 'report' }]), 'A Job named report exists.');
});

test('a new Job leaves out what it has none of', () => {
    assert.deepEqual(jobInput('report', { ...job, schedule: null, timeZone: null }), {
        name: 'report',
        image: 'ghcr.io/acme/report:v3',
        memoryMb: 256,
        cpuMillicores: 250,
        timeoutSeconds: 600,
    });
    assert.deepEqual(jobInput('report', { ...job, homeSite: 'ovh-lim' }), {
        name: 'report',
        image: 'ghcr.io/acme/report:v3',
        memoryMb: 256,
        cpuMillicores: 250,
        timeoutSeconds: 600,
        schedule: '0 3 * * *',
        timeZone: 'Europe/Berlin',
        homeSite: 'ovh-lim',
    });
});

test('a change sends only what differs, null to take the schedule away, and says when nothing differs', () => {
    assert.deepEqual(jobPatch(job, { ...job, schedule: null, timeZone: null, timeoutSeconds: 60 }), { schedule: null, timeZone: null, timeoutSeconds: 60 });
    assert.deepEqual(jobPatch(job, { ...job, image: 'ghcr.io/acme/report:v4' }), { image: 'ghcr.io/acme/report:v4' });
    assert.match(String(jobPatch(job, job)), /Nothing is changed/);
});

test('when a Job runs, and how long a run took', () => {
    assert.equal(scheduleLabel({ schedule: null, timeZone: null }), 'runs when started');
    assert.equal(scheduleLabel({ schedule: '@daily', timeZone: null }), 'runs at @daily (UTC) and when started');
    assert.equal(scheduleLabel(job), 'runs at 0 3 * * * (Europe/Berlin) and when started');
    assert.equal(formatSeconds(45), '45 s');
    assert.equal(formatSeconds(720), '12 min');
    assert.equal(formatSeconds(3599), '1 h');
    assert.equal(formatSeconds(3600), '1 h');
    assert.equal(formatSeconds(11100), '3 h 5 min');
    const startedAt = '2026-11-17T10:00:00Z';
    assert.equal(runDuration({ startedAt: null, finishedAt: null }, 0), undefined);
    assert.equal(runDuration({ startedAt, finishedAt: '2026-11-17T10:00:30Z' }, 0), '30 s');
    assert.equal(runDuration({ startedAt, finishedAt: null }, Date.parse('2026-11-17T10:05:00Z')), '5 min');
});
