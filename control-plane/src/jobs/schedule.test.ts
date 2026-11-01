import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTimeZone, scheduleError } from './schedule.js';

test('schedules a CronJob takes are accepted', () => {
    for (const schedule of [
        '* * * * *',
        '*/15 * * * *',
        '0 3 * * *',
        '30 2 1 * *',
        '0 9-17/2 * * MON-FRI',
        '0 0 ? JAN,jul sun',
        '5,35 0-23/6 1-15 1-12 0-6',
        '10/20 * * * *',
        '@hourly',
        '@daily',
        '@yearly',
    ]) {
        assert.equal(scheduleError(schedule), undefined, schedule);
    }
});

test('others are refused with what is wrong', () => {
    assert.match(scheduleError('* * * *') ?? '', /five fields/);
    assert.match(scheduleError('* * * * * *') ?? '', /five fields/);
    assert.match(scheduleError('60 * * * *') ?? '', /minute: 60 is outside 0-59/);
    assert.match(scheduleError('0 24 * * *') ?? '', /hour/);
    assert.match(scheduleError('0 0 0 * *') ?? '', /day of month: 0/);
    assert.match(scheduleError('0 0 * 13 *') ?? '', /month/);
    assert.match(scheduleError('0 0 * * 7') ?? '', /day of week/);
    assert.match(scheduleError('0 0 * * FOO') ?? '', /not a value/);
    assert.match(scheduleError('5-1 * * * *') ?? '', /outside/);
    assert.match(scheduleError('*/0 * * * *') ?? '', /step of 0/);
    assert.match(scheduleError('*/x * * * *') ?? '', /bad step/);
    assert.match(scheduleError('? * * * *') ?? '', /minute/);
    assert.match(scheduleError('@every 5m') ?? '', /not one of/);
    assert.match(scheduleError('TZ=Europe/Berlin 0 3 * * *') ?? '', /five fields/);
    assert.match(scheduleError('0 3 * * L') ?? '', /day of week/);
});

test('time zones are IANA names, aliases included; offsets and unknown names are not', () => {
    for (const name of ['UTC', 'Etc/UTC', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Calcutta', 'America/Argentina/Buenos_Aires']) {
        assert.equal(isTimeZone(name), true, name);
    }
    for (const name of ['', 'Mars/Base', '+01:00', 'Europe/../etc', ' Europe/Berlin']) {
        assert.equal(isTimeZone(name), false, name);
    }
});
