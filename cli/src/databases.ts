/**
 * `oup pg`: Databases of the linked Project (ARCHITECTURE.md, "Postgres" and
 * "Backups"). Pure helpers; index.ts does the calls.
 */
import { DATABASE_MIN_MEMORY_MB, type DatabaseDetails, type DatabaseInput, type Site, UUID } from '@openupstream/sdk';

/** What `oup pg create` gives a Database for the flags left out. */
export const DATABASE_DEFAULTS = { memoryMb: DATABASE_MIN_MEMORY_MB, storageGb: 1 } as const;

/** RFC 3339 with an explicit offset, as the API wants it; a bare time would be read in some server's zone. */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** How storage grows, in a few words: `auto`, `auto ≤ 20 GB` or `manual`. */
export const growthOf = (database: Pick<DatabaseDetails, 'autoGrow' | 'maxStorageGb'>): string =>
    !database.autoGrow ? 'manual' : database.maxStorageGb === null ? 'auto' : `auto ≤ ${database.maxStorageGb} GB`;

export interface GrowthFlags {
    readonly 'max-storage'?: string | undefined;
    readonly 'no-max-storage'?: boolean | undefined;
    readonly 'auto-grow'?: boolean | undefined;
    readonly 'no-auto-grow'?: boolean | undefined;
}

/** The auto-grow settings the flags ask for (decision 111); empty when they say nothing. */
export function growthSettings(flags: GrowthFlags): { ok: true; settings: Pick<DatabaseInput, 'autoGrow' | 'maxStorageGb'> } | { ok: false; reason: string } {
    if (flags['max-storage'] !== undefined && flags['no-max-storage'] === true) {
        return { ok: false, reason: '--max-storage and --no-max-storage exclude each other' };
    }
    if (flags['auto-grow'] === true && flags['no-auto-grow'] === true) {
        return { ok: false, reason: '--auto-grow and --no-auto-grow exclude each other' };
    }
    const max = flags['max-storage'] === undefined ? undefined : Number(flags['max-storage']);
    if (max !== undefined && !(Number.isInteger(max) && max > 0)) {
        return { ok: false, reason: `--max-storage must be a positive whole number of GB, not ${flags['max-storage']}` };
    }
    const autoGrow = flags['no-auto-grow'] === true ? false : flags['auto-grow'] === true ? true : undefined;
    return {
        ok: true,
        settings: {
            ...(autoGrow === undefined ? {} : { autoGrow }),
            ...(max !== undefined ? { maxStorageGb: max } : flags['no-max-storage'] === true ? { maxStorageGb: null } : {}),
        },
    };
}

/** One line per Database: name, state, Home site, memory and storage, and what it was restored from. */
export const formatDatabases = (databases: readonly DatabaseDetails[]): string[] =>
    databases.map((database) => {
        const restored =
            database.restoredFrom === undefined
                ? ''
                : `  restored from ${database.restoredFrom.databaseId}${database.restoredFrom.targetTime === undefined ? '' : ` at ${database.restoredFrom.targetTime}`}`;
        return `${database.name.padEnd(24)} ${database.state.padEnd(12)} ${database.homeSite.padEnd(13)} ${String(database.memoryMb).padStart(6)} MB ${String(database.storageGb).padStart(4)} GB  ${growthOf(database).padEnd(14)}${restored}`;
    });

export interface RestoreFlags {
    /** The source: the name of a live Database of the Project, or the id of a live or deleted one. */
    readonly source: string;
    readonly name: string;
    readonly time?: string;
    readonly memoryMb?: number;
    readonly storageGb?: number;
    readonly homeSite?: Site;
}

/**
 * The create request for `oup pg restore`. Memory, storage and Home site
 * default to the source's when it is live; a deleted source is no longer
 * listed, so its id and the storage are needed (a disk smaller than its
 * data would fail the restore).
 */
export function planRestore(databases: readonly DatabaseDetails[], flags: RestoreFlags): { ok: true; input: DatabaseInput } | { ok: false; reason: string } {
    const live = databases.find((database) => database.name === flags.source || database.id === flags.source);
    if (live === undefined && !UUID.test(flags.source)) {
        return { ok: false, reason: `no Database ${flags.source}; a deleted one is restored by its id` };
    }
    if (live === undefined && flags.storageGb === undefined) {
        return { ok: false, reason: 'restoring a deleted Database needs --storage, at least the size of its data' };
    }
    if (flags.time !== undefined && !RFC3339.test(flags.time)) {
        return { ok: false, reason: `--time takes an RFC 3339 time with its zone, e.g. 2026-11-10T09:30:00Z or 2026-11-10T10:30:00+01:00, not ${flags.time}` };
    }
    const homeSite = flags.homeSite ?? live?.homeSite;
    return {
        ok: true,
        input: {
            name: flags.name,
            memoryMb: flags.memoryMb ?? live?.memoryMb ?? DATABASE_DEFAULTS.memoryMb,
            storageGb: flags.storageGb ?? live?.storageGb ?? DATABASE_DEFAULTS.storageGb,
            ...(homeSite === undefined ? {} : { homeSite }),
            restoreFrom: { databaseId: live?.id ?? flags.source, ...(flags.time === undefined ? {} : { targetTime: flags.time }) },
        },
    };
}
