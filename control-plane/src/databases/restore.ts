/**
 * Whether a restore can reach the point it asks for (ARCHITECTURE.md,
 * "Backups", decision 108), checked before its row is written, so a restore
 * that CloudNativePG could only fail never becomes a Database stuck in
 * `provisioning`.
 *
 * Pure: the caller reads the source's row and its ObjectStore's recovery
 * window.
 */
import type { RecoveryWindow } from '../kube.js';
import { type Result, err, ok } from '../result.js';
import type { RestoreSourceRecord } from './store.js';

/**
 * How late WAL can reach the archive: CloudNativePG's `archive_timeout` of
 * 5 minutes switches to a new segment at least that often, and only full
 * segments are archived. A target later than this before now (or before
 * the source's deletion) may lie in WAL the archive does not have yet, and
 * Postgres refuses to finish a recovery that ends before its target.
 */
export const ARCHIVE_DELAY_MS = 5 * 60_000;

export type RestoreCheckError =
    | { readonly kind: 'no-backup' }
    | { readonly kind: 'before-first-backup'; readonly earliest: Date }
    | { readonly kind: 'too-recent'; readonly latest: Date; readonly deleted: boolean };

export function checkRestore(
    source: RestoreSourceRecord,
    window: RecoveryWindow | undefined,
    targetTime: Date | undefined,
    now: Date,
): Result<void, RestoreCheckError> {
    const earliest = window?.firstRecoverabilityPoint;
    if (earliest === undefined) {
        return err({ kind: 'no-backup' });
    }
    if (targetTime === undefined) {
        return ok(undefined);
    }
    if (targetTime < earliest) {
        return err({ kind: 'before-first-backup', earliest });
    }
    const latest = new Date((source.deletedAt ?? now).getTime() - ARCHIVE_DELAY_MS);
    return targetTime > latest ? err({ kind: 'too-recent', latest, deleted: source.deletedAt !== undefined }) : ok(undefined);
}

/** The API's answer to a failed check. */
export const restoreCheckMessage = (sourceId: string, error: RestoreCheckError): string => {
    switch (error.kind) {
        case 'no-backup':
            return `Database ${sourceId} has no finished base backup yet; try again in a few minutes`;
        case 'before-first-backup':
            return `targetTime is before ${error.earliest.toISOString()}, the earliest point the backups of ${sourceId} reach`;
        case 'too-recent':
            return error.deleted
                ? `targetTime is after ${error.latest.toISOString()}, the latest point the backups of ${sourceId} surely reach before it was deleted; leave targetTime out for the latest`
                : `targetTime is after ${error.latest.toISOString()}: WAL reaches the archive up to ${ARCHIVE_DELAY_MS / 60_000} minutes late; leave targetTime out for the latest`;
    }
};
