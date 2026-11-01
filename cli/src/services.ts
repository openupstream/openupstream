/**
 * `oup service deploy`: one command that brings a Service to what its flags
 * say, whether or not it exists yet (ARCHITECTURE.md, decision 94).
 *
 * `planServiceDeploy` is pure: no Service of that name → create it; one
 * whose settings differ from the flags → change it, with the image always
 * in the change, so its tag is resolved again; the same settings → deploy
 * the tag again (POST …/deploy). Every deploy thus runs what the tag points
 * at now. Flags left out keep what the Service has; on creation they take
 * the defaults below.
 */
import type { RegistryAuth, ServiceDetails, ServiceInput, ServicePatch, ServiceState, Site } from '@openupstream/sdk';

/** What a new Service gets for the flags left out. */
export const DEFAULTS = { replicas: 1, memoryMb: 256, cpuMillicores: 250 } as const;

/** What the flags ask for; `undefined`: keep what the Service has (or the default). */
export interface DesiredService {
    readonly name: string;
    readonly image: string;
    readonly port?: number;
    readonly replicas?: number;
    readonly memoryMb?: number;
    readonly cpuMillicores?: number;
    readonly homeSite?: Site;
    readonly registryAuth?: RegistryAuth;
}

export type DeployPlan =
    | { readonly kind: 'create'; readonly input: ServiceInput }
    | { readonly kind: 'update'; readonly serviceId: string; readonly patch: ServicePatch }
    | { readonly kind: 'redeploy'; readonly serviceId: string }
    | { readonly kind: 'invalid'; readonly reason: string };

export function planServiceDeploy(existing: ServiceDetails | undefined, desired: DesiredService): DeployPlan {
    if (existing === undefined) {
        if (desired.port === undefined) {
            return { kind: 'invalid', reason: `a new Service needs --port, the port its container listens on` };
        }
        return {
            kind: 'create',
            input: {
                name: desired.name,
                image: desired.image,
                port: desired.port,
                replicas: desired.replicas ?? DEFAULTS.replicas,
                memoryMb: desired.memoryMb ?? DEFAULTS.memoryMb,
                cpuMillicores: desired.cpuMillicores ?? DEFAULTS.cpuMillicores,
                ...(desired.homeSite === undefined ? {} : { homeSite: desired.homeSite }),
                ...(desired.registryAuth === undefined ? {} : { registryAuth: desired.registryAuth }),
            },
        };
    }
    const changed = (Object.entries({
        port: desired.port,
        replicas: desired.replicas,
        memoryMb: desired.memoryMb,
        cpuMillicores: desired.cpuMillicores,
        homeSite: desired.homeSite,
    }) as [keyof ServicePatch, number | Site | undefined][]).filter(([key, value]) => value !== undefined && existing[key as keyof ServiceDetails] !== value);
    if (changed.length === 0 && desired.image === existing.image && desired.registryAuth === undefined) {
        return { kind: 'redeploy', serviceId: existing.id };
    }
    return {
        kind: 'update',
        serviceId: existing.id,
        patch: {
            ...Object.fromEntries(changed),
            image: desired.image,
            ...(desired.registryAuth === undefined ? {} : { registryAuth: desired.registryAuth }),
        },
    };
}

/** One line per Service: name, state, replicas, image and the start of its digest. */
export const formatServices = (services: readonly ServiceDetails[]): string[] =>
    services.map(
        (service) =>
            `${service.name.padEnd(24)} ${service.state.padEnd(10)} ${String(service.replicas).padStart(2)}×  ${service.image} (${service.imageDigest.slice(0, 19)})`,
    );

/** Until the Service is `running`, or the time is up; every state it passes through is reported once. */
export async function waitUntilRunning(
    read: () => Promise<{ readonly ok: true; readonly value: ServiceDetails } | { readonly ok: false; readonly error: { readonly message: string } }>,
    options: { readonly timeoutMs: number; readonly intervalMs: number; readonly report: (state: ServiceState) => void },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
    const deadline = Date.now() + options.timeoutMs;
    let reported: ServiceState | undefined;
    for (;;) {
        const service = await read();
        if (service.ok && service.value.state !== reported) {
            reported = service.value.state;
            options.report(reported);
        }
        if (service.ok && service.value.state === 'running') {
            return { ok: true };
        }
        if (Date.now() >= deadline) {
            return { ok: false, error: service.ok ? `still ${service.value.state} after ${options.timeoutMs / 1000} s` : service.error.message };
        }
        await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    }
}
