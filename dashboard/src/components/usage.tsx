'use client';

import type { Instance, Measured, ResourceUsage } from '@openupstream/sdk';
import { formatBytes, formatCpu, formatMeasured, usedShare } from '../lib/usage';
import { SiteName } from './sites';

/** A Resource's CPU, memory and storage against what it was given, then its instances. */
export function Usage({ usage }: { readonly usage: ResourceUsage }) {
    return (
        <>
            <div className="meters">
                <Meter label="CPU" measured={usage.cpuMillicores} format={formatCpu} />
                <Meter label="Memory" measured={usage.memoryBytes} format={formatBytes} />
                <Meter label="Storage" measured={usage.storageBytes} format={formatBytes} />
            </div>
            {usage.instances.length > 0 && (
                <table>
                    <thead>
                        <tr>
                            <th>Instance</th>
                            <th>Site</th>
                            <th>State</th>
                            <th>CPU</th>
                            <th>Memory</th>
                            <th>Disk</th>
                        </tr>
                    </thead>
                    <tbody>
                        {usage.instances.map((instance) => (
                            <InstanceRow key={instance.name} instance={instance} />
                        ))}
                    </tbody>
                </table>
            )}
        </>
    );
}

const ROLE: Readonly<Record<Instance['role'], string>> = { database: 'Postgres', pooler: 'PgBouncer', replica: 'replica', run: 'run' };

function InstanceRow({ instance }: { readonly instance: Instance }) {
    const value = (measured: number | null, format: (value: number) => string) => (measured === null ? '–' : format(measured));
    return (
        <tr>
            <td>
                {ROLE[instance.role]} <code>{instance.name}</code>
            </td>
            <td>{instance.site === null ? '–' : <SiteName id={instance.site} />}</td>
            <td>
                <span className={`state ${instance.state}`}>{instance.state}</span>
                {instance.restarts > 0 && <small> {instance.restarts} restarts</small>}
            </td>
            <td>{value(instance.cpuMillicores, formatCpu)}</td>
            <td>{value(instance.memoryBytes, formatBytes)}</td>
            <td>{value(instance.storageBytes, formatBytes)}</td>
        </tr>
    );
}

/** One figure with a bar when both what is used and what was given are known; nothing when neither is. */
function Meter(props: { readonly label: string; readonly measured: Measured; readonly format: (value: number) => string }) {
    const text = formatMeasured(props.measured, props.format);
    const share = usedShare(props.measured);
    return text === undefined ? null : (
        <div className="meter">
            <small>{props.label}</small>
            <span>{text}</span>
            {share !== undefined && (
                <div className="bar" role="meter" aria-label={props.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}>
                    <div className={share >= 0.9 ? 'full' : undefined} style={{ width: `${Math.max(1, share * 100)}%` }} />
                </div>
            )}
        </div>
    );
}
