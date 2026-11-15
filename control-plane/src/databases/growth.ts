/**
 * Storage that grows by itself (ARCHITECTURE.md, decision 111): once a
 * Database's fullest volume is 90% used, its storage grows by half, never
 * past its maximum nor past the room its nodes have, through the same row
 * change as a resize (decision 110), so the operator applies it and billing
 * follows. Not while the Account has a Hold, as a resize may not grow then.
 *
 * Usage comes from the platform's Prometheus (decision 106), which scrapes
 * every volume's kubelet stats. Without PROMETHEUS_URL the pass does not run.
 *
 * `planGrowth` is pure; `growthPass` reads, decides and writes.
 */
import { clusterName, projectNamespace } from '@openupstream/sdk';
import type pg from 'pg';
import type { ControlPlaneKube } from '../kube.js';
import { type Result, err, ok } from '../result.js';
import { GiB, roomForGrowth } from './capacity.js';
import { updateDatabase } from './store.js';

/** A Database grows once its fullest volume is this full. */
export const GROW_AT = 0.9;
/** By this share of its size, at least 1 GB. */
export const GROW_BY = 0.5;

/** One Database's volumes as Prometheus last saw them. */
export interface VolumeUsage {
    /** Used share of the fullest volume. */
    readonly used: number;
    /** Size of the smallest volume, in bytes: the filesystem, a little under the requested size. */
    readonly capacityBytes: number;
}

export interface GrowthRow {
    readonly id: string;
    readonly projectId: string;
    readonly name: string;
    readonly storageGb: number;
    readonly maxStorageGb: number | null;
    readonly held: boolean;
}

export type GrowthStep =
    | { readonly kind: 'grow'; readonly row: GrowthRow; readonly toGb: number }
    | { readonly kind: 'at-maximum'; readonly row: GrowthRow; readonly used: number }
    | { readonly kind: 'held'; readonly row: GrowthRow; readonly used: number };

/**
 * A volume smaller than this share of the row's size has not been grown yet
 * (a resize or an earlier growth still on its way), so its usage says
 * nothing about the new size: no second growth on top of the first.
 */
const APPLIED = 0.9;

export function planGrowth(rows: readonly GrowthRow[], usage: ReadonlyMap<string, VolumeUsage>): GrowthStep[] {
    return rows.flatMap((row): GrowthStep[] => {
        const volume = usage.get(row.id);
        if (volume === undefined || volume.used < GROW_AT || volume.capacityBytes < row.storageGb * GiB * APPLIED) {
            return [];
        }
        const wanted = Math.max(row.storageGb + 1, Math.ceil(row.storageGb * (1 + GROW_BY)));
        const toGb = row.maxStorageGb === null ? wanted : Math.min(wanted, row.maxStorageGb);
        if (toGb <= row.storageGb) {
            return [{ kind: 'at-maximum', row, used: volume.used }];
        }
        return [row.held ? { kind: 'held', row, used: volume.used } : { kind: 'grow', row, toGb }];
    });
}

/** `db-<id>-<n>`, the PVC of instance n of a Database's Cluster. */
const INSTANCE_PVC = /^db-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-\d+$/;

export interface PrometheusSample {
    readonly labels: Readonly<Record<string, string>>;
    readonly value: number;
}

/**
 * Per Database: the fullest volume's used share and the smallest volume's
 * size, from kubelet_volume_stats per PVC. PVCs not named like a
 * Database's instance are left out.
 */
export function usageOf(used: readonly PrometheusSample[], capacity: readonly PrometheusSample[]): Map<string, VolumeUsage> {
    const byDatabase = (samples: readonly PrometheusSample[], pick: (a: number, b: number) => number) =>
        samples.reduce((map, sample) => {
            const id = INSTANCE_PVC.exec(sample.labels['persistentvolumeclaim'] ?? '')?.[1];
            if (id === undefined || !Number.isFinite(sample.value)) {
                return map;
            }
            const seen = map.get(id);
            return new Map(map).set(id, seen === undefined ? sample.value : pick(seen, sample.value));
        }, new Map<string, number>());
    const usedById = byDatabase(used, Math.max);
    const capacityById = byDatabase(capacity, Math.min);
    return new Map(
        [...usedById].flatMap(([id, share]): [string, VolumeUsage][] => {
            const capacityBytes = capacityById.get(id);
            return capacityBytes === undefined ? [] : [[id, { used: share, capacityBytes }]];
        }),
    );
}

/** An instant query against Prometheus's HTTP API. */
export type PrometheusQuery = (query: string) => Promise<Result<PrometheusSample[], string>>;

export const prometheusClient =
    (url: string, fetchImpl: typeof fetch = fetch): PrometheusQuery =>
    async (query) => {
        const response = await fetchImpl(`${url.replace(/\/$/, '')}/api/v1/query?${new URLSearchParams({ query })}`, {
            signal: AbortSignal.timeout(10_000),
        }).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
        if (response instanceof Error) {
            return err(response.message);
        }
        if (!response.ok) {
            return err(`Prometheus answered ${response.status}`);
        }
        const body = (await response.json()) as {
            data?: { result?: { metric?: Record<string, string>; value?: [number, string] }[] };
        };
        return ok((body.data?.result ?? []).map((sample) => ({ labels: sample.metric ?? {}, value: Number(sample.value?.[1]) })));
    };

const VOLUMES = 'namespace=~"project-.*", persistentvolumeclaim=~"db-.*"';
export const USED_QUERY = `kubelet_volume_stats_used_bytes{${VOLUMES}} / kubelet_volume_stats_capacity_bytes{${VOLUMES}}`;
export const CAPACITY_QUERY = `kubelet_volume_stats_capacity_bytes{${VOLUMES}}`;

export interface GrowthDeps {
    readonly pool: pg.Pool;
    readonly kube: ControlPlaneKube;
    readonly prometheus: PrometheusQuery;
    readonly log: (entry: Record<string, unknown>) => void;
}

/** Grows what planGrowth says, each by as much as its nodes have room for. */
export async function growthPass(deps: GrowthDeps): Promise<void> {
    const [used, capacity] = await Promise.all([deps.prometheus(USED_QUERY), deps.prometheus(CAPACITY_QUERY)]);
    if (!used.ok || !capacity.ok) {
        deps.log({ msg: 'growth: cannot ask Prometheus', error: used.ok ? (capacity.ok ? '' : capacity.error) : used.error });
        return;
    }
    const { rows } = await deps.pool.query<{
        id: string;
        project_id: string;
        name: string;
        storage_gb: number;
        max_storage_gb: number | null;
        held: boolean;
    }>(
        `select d.id, d.project_id, d.name, d.storage_gb, d.max_storage_gb,
                exists (select 1 from account_holds h where h.account_id = p.account_id) as held
         from databases d join projects p on p.id = d.project_id
         where d.deleted_at is null and d.auto_grow`,
    );
    const steps = planGrowth(
        rows.map((row) => ({ id: row.id, projectId: row.project_id, name: row.name, storageGb: row.storage_gb, maxStorageGb: row.max_storage_gb, held: row.held })),
        usageOf(used.value, capacity.value),
    );
    for (const step of steps) {
        if (step.kind !== 'grow') {
            deps.log({ msg: step.kind === 'held' ? 'growth: held, not grown' : 'growth: at its maximum', database: step.row.id, used: step.used });
            continue;
        }
        const toGb = await fitting(deps.kube, step.row, step.toGb);
        if (!toGb.ok) {
            deps.log({ msg: 'growth: no room on its nodes', database: step.row.id, wantedGb: step.toGb, error: toGb.error });
            continue;
        }
        await updateDatabase(deps.pool, step.row.projectId, step.row.id, { storageGb: toGb.value });
        deps.log({ msg: 'growth: grown', database: step.row.id, fromGb: step.row.storageGb, toGb: toGb.value });
    }
}

/**
 * `wantedGb`, or as much as the nodes holding the volumes have room for if
 * that is less, but at least 1 GB more; an error when not even that fits.
 * Without TopoLVM's figures, `wantedGb` unchecked, as a resize would be.
 */
async function fitting(kube: ControlPlaneKube, row: GrowthRow, wantedGb: number): Promise<Result<number, string>> {
    const [capacity, nodes] = await Promise.all([kube.storageCapacity(), kube.volumeNodes(projectNamespace(row.projectId), clusterName(row))]);
    if (!capacity.ok || !nodes.ok || capacity.value === undefined || nodes.value.length === 0) {
        return ok(wantedGb);
    }
    const room = roomForGrowth(capacity.value, nodes.value, (wantedGb - row.storageGb) * GiB);
    if (room.ok) {
        return ok(wantedGb);
    }
    const extraGb = Math.floor(room.error.largest / GiB);
    return extraGb >= 1 ? ok(row.storageGb + extraGb) : err(`${Math.floor(room.error.largest / GiB)} GB free`);
}
