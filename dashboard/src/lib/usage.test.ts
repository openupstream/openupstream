import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databaseNameProblem, databaseSizes, databaseUrlVariable, formatBytes, formatCpu, formatMeasured, resizeOf, usedShare } from './usage';

test('bytes in the largest unit, CPU in CPUs', () => {
    assert.deepEqual([0, 512, 1024, 138_092_544, 2 ** 30, 1.5 * 2 ** 30, 250 * 2 ** 30, 2 ** 50].map(formatBytes), ['0 B', '512 B', '1.0 KB', '132 MB', '1.0 GB', '1.5 GB', '250 GB', '1024 TB']);
    assert.deepEqual([0, 129, 1500].map(formatCpu), ['0.00 CPU', '0.13 CPU', '1.50 CPU']);
});

test('used of allocated, with whatever is known', () => {
    assert.equal(formatMeasured({ used: 2 ** 20, allocated: 2 ** 30 }, formatBytes), '1.0 MB of 1.0 GB');
    assert.equal(formatMeasured({ used: 129, allocated: null }, formatCpu), '0.13 CPU');
    assert.equal(formatMeasured({ used: null, allocated: 200 }, formatCpu), '0.20 CPU allocated');
    assert.equal(formatMeasured({ used: null, allocated: null }, formatCpu), undefined);
    assert.deepEqual(
        [{ used: 1, allocated: 4 }, { used: 9, allocated: 4 }, { used: null, allocated: 4 }, { used: 1, allocated: null }, { used: 1, allocated: 0 }].map(usedShare),
        [0.25, 1, undefined, undefined, undefined],
    );
});

test('a Database form: sizes as whole numbers within the limits, a free DNS label as name', () => {
    assert.deepEqual(databaseSizes(' 512 ', '10'), { memoryMb: 512, storageGb: 10 });
    assert.match(String(databaseSizes('128', '10')), /at least 256/);
    assert.match(String(databaseSizes('512.5', '10')), /Memory is a whole number/);
    assert.match(String(databaseSizes('512', '0')), /Storage is a whole number/);
    assert.match(String(databaseSizes('512', '')), /Storage/);
    assert.equal(databaseNameProblem('main', [{ name: 'other' }]), undefined);
    assert.match(databaseNameProblem('Main', []) ?? '', /Lowercase/);
    assert.equal(databaseNameProblem('main', [{ name: 'main' }]), 'A Database named main exists.');
});

test('a resize sends only what changes and never shrinks storage', () => {
    const now = { memoryMb: 512, storageGb: 10 };
    assert.deepEqual(resizeOf(now, { memoryMb: 1024, storageGb: 10 }), { memoryMb: 1024 });
    assert.deepEqual(resizeOf(now, { memoryMb: 256, storageGb: 20 }), { memoryMb: 256, storageGb: 20 });
    assert.equal(resizeOf(now, { memoryMb: 512, storageGb: 5 }), 'Storage only grows: it is 10 GB now.');
    assert.equal(resizeOf(now, now), 'These are the sizes it has.');
});

test("the variable with a Database's URL", () => {
    assert.equal(databaseUrlVariable('orders-eu'), 'DATABASE_URL_ORDERS_EU');
});
