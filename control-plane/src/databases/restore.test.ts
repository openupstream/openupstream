import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ARCHIVE_DELAY_MS, checkRestore } from './restore.js';

const now = new Date('2026-11-10T12:00:00Z');
const window = { firstRecoverabilityPoint: new Date('2026-11-01T03:00:00Z'), lastSuccessfulBackupTime: new Date('2026-11-10T03:00:00Z') };
const live = { id: 'a', deletedAt: undefined };
const deleted = { id: 'a', deletedAt: new Date('2026-11-09T12:00:00Z') };

describe('checkRestore', () => {
    test('needs a finished base backup', () => {
        assert.deepEqual(checkRestore(live, undefined, undefined, now), { ok: false, error: { kind: 'no-backup' } });
        assert.equal(checkRestore(live, { firstRecoverabilityPoint: undefined, lastSuccessfulBackupTime: undefined }, undefined, now).ok, false);
    });

    test('without a target time: the latest point, live or deleted', () => {
        assert.equal(checkRestore(live, window, undefined, now).ok, true);
        assert.equal(checkRestore(deleted, window, undefined, now).ok, true);
    });

    test('not before the first recoverability point', () => {
        assert.equal(checkRestore(live, window, window.firstRecoverabilityPoint, now).ok, true);
        assert.deepEqual(checkRestore(live, window, new Date('2026-11-01T02:59:59Z'), now), {
            ok: false,
            error: { kind: 'before-first-backup', earliest: window.firstRecoverabilityPoint },
        });
    });

    test('not later than the archive surely reaches: now, or the deletion, less the archive delay', () => {
        const latest = new Date(now.getTime() - ARCHIVE_DELAY_MS);
        assert.equal(checkRestore(live, window, latest, now).ok, true);
        assert.deepEqual(checkRestore(live, window, new Date(latest.getTime() + 1000), now), {
            ok: false,
            error: { kind: 'too-recent', latest, deleted: false },
        });
        const beforeDelete = new Date((deleted.deletedAt as Date).getTime() - ARCHIVE_DELAY_MS);
        assert.equal(checkRestore(deleted, window, beforeDelete, now).ok, true);
        assert.equal(checkRestore(deleted, window, new Date(beforeDelete.getTime() + 1000), now).ok, false);
    });
});
