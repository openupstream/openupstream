import { DATABASE_MIN_MEMORY_MB, DNS_LABEL, type Database, type Measured } from '@openupstream/sdk';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Bytes in the largest unit that keeps the number at 1 or more; 1 GB is 2^30 bytes, as the sizes are. */
export const formatBytes = (bytes: number): string => {
    const power = bytes < 1 ? 0 : Math.min(UNITS.length - 1, Math.floor(Math.log2(bytes) / 10));
    const value = bytes / 2 ** (10 * power);
    return `${power === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${UNITS[power]}`;
};

/** Millicores as CPUs: `0.13 CPU`. */
export const formatCpu = (millicores: number): string => `${(millicores / 1000).toFixed(2)} CPU`;

/** `used of allocated`, whichever of the two is known; undefined when neither is. */
export const formatMeasured = (measured: Measured, format: (value: number) => string): string | undefined =>
    measured.used !== null && measured.allocated !== null
        ? `${format(measured.used)} of ${format(measured.allocated)}`
        : measured.used !== null
          ? format(measured.used)
          : measured.allocated !== null
            ? `${format(measured.allocated)} allocated`
            : undefined;

/** The used share of what was allocated, 0 to 1; undefined when it cannot be said. */
export const usedShare = (measured: Measured): number | undefined =>
    measured.used === null || measured.allocated === null || measured.allocated <= 0 ? undefined : Math.min(1, Math.max(0, measured.used / measured.allocated));

/** What a form's number field holds, when it is a whole number; undefined otherwise. */
export const whole = (text: string): number | undefined => (/^\d{1,7}$/.test(text.trim()) ? Number(text.trim()) : undefined);

export interface DatabaseSizes {
    readonly memoryMb: number;
    readonly storageGb: number;
}

/** The sizes a form holds as text; what is wrong with them otherwise. */
export const databaseSizes = (memoryMb: string, storageGb: string): DatabaseSizes | string => {
    const memory = whole(memoryMb);
    const storage = whole(storageGb);
    return memory === undefined || memory < DATABASE_MIN_MEMORY_MB
        ? `Memory is a whole number of MB, at least ${DATABASE_MIN_MEMORY_MB}.`
        : storage === undefined || storage < 1
          ? 'Storage is a whole number of GB, at least 1.'
          : { memoryMb: memory, storageGb: storage };
};

/** What is wrong with a new Database's name; undefined when nothing is. */
export const databaseNameProblem = (name: string, existing: readonly Pick<Database, 'name'>[]): string | undefined =>
    !DNS_LABEL.test(name)
        ? 'Lowercase letters, digits and hyphens, starting with a letter, at most 63 characters, e.g. main.'
        : existing.some((database) => database.name === name)
          ? `A Database named ${name} exists.`
          : undefined;

/** What a resize changes, for the API; a problem when it would shrink the storage or change nothing. */
export const resizeOf = (database: DatabaseSizes, wanted: DatabaseSizes): Partial<DatabaseSizes> | string =>
    wanted.storageGb < database.storageGb
        ? `Storage only grows: it is ${database.storageGb} GB now.`
        : wanted.memoryMb === database.memoryMb && wanted.storageGb === database.storageGb
          ? 'These are the sizes it has.'
          : {
                ...(wanted.memoryMb === database.memoryMb ? {} : { memoryMb: wanted.memoryMb }),
                ...(wanted.storageGb === database.storageGb ? {} : { storageGb: wanted.storageGb }),
            };

/** The variable a Service or Job finds the Database's URL in (decision 97). */
export const databaseUrlVariable = (name: string): string => `DATABASE_URL_${name.toUpperCase().replaceAll('-', '_')}`;
