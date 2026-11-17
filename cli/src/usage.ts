/**
 * `oup usage`: what a Project's Resources use now, as a table. Pure, so it
 * is tested without an API. The number formats are the dashboard's
 * (`dashboard/src/lib/usage.ts`), which cannot be imported from here.
 */
import type { Instance, Measured, ProjectUsage, ResourceUsage } from '@openupstream/sdk';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Bytes in the largest unit that keeps the number at 1 or more; 1 GB is 2^30 bytes, as the sizes are. */
export const formatBytes = (bytes: number): string => {
    const power = bytes < 1 ? 0 : Math.min(UNITS.length - 1, Math.floor(Math.log2(bytes) / 10));
    const value = bytes / 2 ** (10 * power);
    return `${power === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${UNITS[power]}`;
};

/** Millicores as CPUs: `0.13 CPU`. */
export const formatCpu = (millicores: number): string => `${(millicores / 1000).toFixed(2)} CPU`;

/** `used of allocated`, whichever of the two is known; `-` when neither is. */
export const formatMeasured = (measured: Measured, format: (value: number) => string): string =>
    measured.used !== null && measured.allocated !== null
        ? `${format(measured.used)} of ${format(measured.allocated)}`
        : measured.used !== null
          ? format(measured.used)
          : measured.allocated !== null
            ? `${format(measured.allocated)} allocated`
            : '-';

/** Rows as lines, every column as wide as its widest cell. */
const table = (rows: readonly (readonly string[])[], indent = ''): string[] => {
    const widths = (rows[0] ?? []).map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length)));
    return rows.map((row) => `${indent}${row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ')}`.trimEnd());
};

const KIND = { database: 'Database', service: 'Service', job: 'Job', bucket: 'Bucket' } as const;

const resourceRow = (resource: ResourceUsage): string[] => [
    KIND[resource.kind],
    resource.name,
    formatMeasured(resource.cpuMillicores, formatCpu),
    formatMeasured(resource.memoryBytes, formatBytes),
    formatMeasured(resource.storageBytes, formatBytes),
];

const orDash = <T>(value: T | null, format: (value: T) => string): string => (value === null ? '-' : format(value));

const instanceRow = (instance: Instance): string[] => [
    `${instance.role} ${instance.name}`,
    instance.site ?? 'not placed',
    `${instance.state}${instance.restarts === 0 ? '' : `, ${instance.restarts} ${instance.restarts === 1 ? 'restart' : 'restarts'}`}`,
    orDash(instance.cpuMillicores, formatCpu),
    orDash(instance.memoryBytes, formatBytes),
    orDash(instance.storageBytes, formatBytes),
];

/**
 * The Project's Resources with what each uses now of what it was given,
 * and with `instances` every running copy below its Resource. Says when
 * nothing is measured, and that this is not what is billed.
 */
export const formatUsage = (usage: ProjectUsage, project: string, options: { readonly instances: boolean }): string[] => {
    if (usage.resources.length === 0) {
        return [`No Resources in ${project}.`];
    }
    const header = ['KIND', 'NAME', 'CPU', 'MEMORY', 'STORAGE'];
    const rows = table([header, ...usage.resources.map(resourceRow)]);
    const lines = options.instances
        ? [rows[0] ?? '', ...usage.resources.flatMap((resource, index) => [rows[index + 1] ?? '', ...table(resource.instances.map(instanceRow), '    ')])]
        : rows;
    return [
        ...lines,
        '',
        usage.measured
            ? `Measured ${usage.measuredAt}: use now of what was given, not what is billed.`
            : 'CPU, memory and disk are not measured right now: this installation has no Prometheus, or it did not answer.',
    ];
};
