/**
 * An Account's usage of one month for the billing service (decision 114):
 * usage events summed per Project, Resource and unit, and how many hours of
 * the month are metered, so it rates a month only once it is complete.
 */
import type { AccountUsage, ResourceKind, UsageUnit } from '@openupstream/sdk';
import type pg from 'pg';

/** `YYYY-MM`, a calendar month in UTC. */
export const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The month's first instant and the next month's, in UTC; undefined for anything but `YYYY-MM`. */
export const monthBounds = (month: string): { readonly start: Date; readonly end: Date } | undefined => {
    const match = MONTH.exec(month);
    if (match === null) {
        return undefined;
    }
    const [year, index] = [Number(match[1]), Number(match[2]) - 1];
    return { start: new Date(Date.UTC(year, index, 1)), end: new Date(Date.UTC(year, index + 1, 1)) };
};

export async function accountUsage(pool: pg.Pool, accountId: string, month: string): Promise<AccountUsage | undefined> {
    const bounds = monthBounds(month);
    if (bounds === undefined) {
        return undefined;
    }
    const [sums, metered] = await Promise.all([
        pool.query<{ project_id: string; resource_kind: ResourceKind; resource_id: string; unit: UsageUnit; quantity: string }>(
            `select project_id, resource_kind, resource_id, unit, sum(quantity) as quantity from usage_events
             where account_id = $1 and interval_start >= $2 and interval_start < $3
             group by project_id, resource_kind, resource_id, unit
             order by project_id, resource_kind, resource_id, unit`,
            [accountId, bounds.start, bounds.end],
        ),
        pool.query<{ hours: string }>('select count(*) as hours from metered_hours where hour >= $1 and hour < $2', [bounds.start, bounds.end]),
    ]);
    return {
        accountId,
        month,
        hours: (bounds.end.getTime() - bounds.start.getTime()) / 3600_000,
        meteredHours: Number(metered.rows[0]?.hours ?? 0),
        usage: sums.rows.map((row) => ({
            projectId: row.project_id,
            resource: { kind: row.resource_kind, id: row.resource_id },
            unit: row.unit,
            quantity: Number(row.quantity),
        })),
    };
}
