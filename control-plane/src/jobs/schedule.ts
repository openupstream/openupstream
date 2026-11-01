/**
 * What the API accepts as a Job's schedule and time zone: what a Kubernetes
 * CronJob accepts, checked before the row is written, so the Jobs operator
 * never meets a CronJob the API server refuses.
 *
 * A schedule is five fields (minute, hour, day of month, month, day of
 * week), as Kubernetes parses them (robfig/cron's standard parser), or one
 * of the descriptors below. `TZ=` prefixes are refused: the time zone is
 * its own field.
 */

const DESCRIPTORS = new Set(['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly']);

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

interface Field {
    readonly name: string;
    readonly min: number;
    readonly max: number;
    /** Names for values, the first one standing for `min`. */
    readonly names?: readonly string[];
    /** Whether `?` may stand for `*`. */
    readonly question?: boolean;
}

const FIELDS: readonly Field[] = [
    { name: 'minute', min: 0, max: 59 },
    { name: 'hour', min: 0, max: 23 },
    { name: 'day of month', min: 1, max: 31, question: true },
    { name: 'month', min: 1, max: 12, names: MONTHS },
    { name: 'day of week', min: 0, max: 6, names: DAYS, question: true },
];

/** The value a number or name stands for in the field; undefined when it is neither. */
const valueOf = (field: Field, text: string): number | undefined => {
    if (/^\d{1,2}$/.test(text)) {
        return Number(text);
    }
    const named = field.names?.indexOf(text.toUpperCase()) ?? -1;
    return named < 0 ? undefined : field.min + named;
};

/** Why one comma-separated part of a field is wrong; undefined when it is right. */
function partError(field: Field, part: string): string | undefined {
    const [range = '', step, ...rest] = part.split('/');
    if (rest.length > 0 || (step !== undefined && !/^\d{1,2}$/.test(step))) {
        return `${field.name}: ${part} has a bad step`;
    }
    if (step !== undefined && Number(step) === 0) {
        return `${field.name}: a step of 0`;
    }
    if (range === '*' || (field.question === true && range === '?')) {
        return undefined;
    }
    const [low, high, ...more] = range.split('-');
    const from = valueOf(field, low ?? '');
    const to = high === undefined ? from : valueOf(field, high);
    if (more.length > 0 || from === undefined || to === undefined) {
        return `${field.name}: ${part} is not a value, a range or *`;
    }
    if (from < field.min || to > field.max || from > to) {
        return `${field.name}: ${part} is outside ${field.min}-${field.max}`;
    }
    return undefined;
}

/** Why the schedule would not be accepted; undefined when it would. */
export function scheduleError(schedule: string): string | undefined {
    const trimmed = schedule.trim();
    if (trimmed.startsWith('@')) {
        return DESCRIPTORS.has(trimmed) ? undefined : `${trimmed} is not one of ${[...DESCRIPTORS].join(', ')}`;
    }
    const fields = trimmed.split(/\s+/);
    if (fields.length !== FIELDS.length) {
        return 'five fields: minute, hour, day of month, month, day of week';
    }
    return FIELDS.flatMap((field, i) => (fields[i] ?? '').split(',').map((part) => partError(field, part))).find(
        (error) => error !== undefined,
    );
}

/**
 * Whether the name is an IANA time zone a CronJob takes, e.g.
 * `Europe/Berlin`. `Intl.supportedValuesOf` lists only one name per zone
 * (`Asia/Calcutta`, not `Asia/Kolkata`); the only check that knows every
 * name throws on an unknown one.
 */
export function isTimeZone(name: string): boolean {
    if (!/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)*$/.test(name)) {
        return false;
    }
    try {
        new Intl.DateTimeFormat('en', { timeZone: name });
        return true;
    } catch {
        return false;
    }
}
