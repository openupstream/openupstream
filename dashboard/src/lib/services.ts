import { COMPUTE_SITES, DNS_LABEL, SERVICE_LIMITS, type Service, type ServiceInput, type ServicePatch, type Site } from '@openupstream/sdk';

/** What a Service form holds, as typed. `port` empty: a worker; `homeSite` empty: wherever the Project's data is. */
export interface ServiceFields {
    readonly image: string;
    readonly port: string;
    readonly replicas: string;
    readonly memoryMb: string;
    readonly cpuMillicores: string;
    readonly homeSite: string;
}

/** What the form means, with every field said: null where the Service has none. */
export interface ServiceWanted {
    readonly image: string;
    readonly port: number | null;
    readonly replicas: number;
    readonly memoryMb: number;
    readonly cpuMillicores: number;
    readonly homeSite: Site | null;
}

export const NEW_SERVICE: ServiceFields = { image: '', port: '8080', replicas: '1', memoryMb: '256', cpuMillicores: '250', homeSite: '' };

export const fieldsOf = (service: Pick<Service, 'image' | 'port' | 'replicas' | 'memoryMb' | 'cpuMillicores' | 'homeSite'>): ServiceFields => ({
    image: service.image,
    port: service.port === null ? '' : String(service.port),
    replicas: String(service.replicas),
    memoryMb: String(service.memoryMb),
    cpuMillicores: String(service.cpuMillicores),
    homeSite: service.homeSite ?? '',
});

const whole = (text: string): number | undefined => (/^\d{1,7}$/.test(text.trim()) ? Number(text.trim()) : undefined);
const within = (value: number | undefined, least: number, most: number): value is number => value !== undefined && value >= least && value <= most;

/** The fields as values; what is wrong with them otherwise. The API checks the same and more (that the image exists). */
export const serviceWanted = (fields: ServiceFields): ServiceWanted | string => {
    const image = fields.image.trim();
    const port = fields.port.trim() === '' ? null : whole(fields.port);
    const replicas = whole(fields.replicas);
    const memoryMb = whole(fields.memoryMb);
    const cpuMillicores = whole(fields.cpuMillicores);
    const homeSite = fields.homeSite === '' ? null : COMPUTE_SITES.find((site) => site === fields.homeSite);
    return image === '' || /\s/.test(image)
        ? 'Enter the image, e.g. ghcr.io/acme/api:v3.'
        : port !== null && !within(port, 1, 65535)
          ? 'The port is a number from 1 to 65535, or empty for a worker that serves no HTTP.'
          : !within(replicas, 1, SERVICE_LIMITS.maxReplicas)
            ? `Replicas are a whole number from 1 to ${SERVICE_LIMITS.maxReplicas}.`
            : !within(memoryMb, SERVICE_LIMITS.minMemoryMb, SERVICE_LIMITS.maxMemoryMb)
              ? `Memory is a whole number of MB from ${SERVICE_LIMITS.minMemoryMb} to ${SERVICE_LIMITS.maxMemoryMb}.`
              : !within(cpuMillicores, SERVICE_LIMITS.minCpuMillicores, SERVICE_LIMITS.maxCpuMillicores)
                ? `CPU is a whole number of millicores from ${SERVICE_LIMITS.minCpuMillicores} to ${SERVICE_LIMITS.maxCpuMillicores} (1000 is one CPU).`
                : homeSite === undefined
                  ? 'Choose a Site from the list.'
                  : { image, port, replicas, memoryMb, cpuMillicores, homeSite };
};

/** What is wrong with a new Service's name; undefined when nothing is. */
export const serviceNameProblem = (name: string, existing: readonly Pick<Service, 'name'>[]): string | undefined =>
    name === ''
        ? 'Enter a name.'
        : !DNS_LABEL.test(name)
          ? 'Lowercase letters, digits and hyphens, starting with a letter, at most 63 characters, e.g. api.'
          : existing.some((service) => service.name === name)
            ? `A Service named ${name} exists.`
            : undefined;

/** A new Service for the API: a worker has no port, and no Site means no choice. */
export const serviceInput = (name: string, wanted: ServiceWanted): ServiceInput => ({
    name,
    image: wanted.image,
    replicas: wanted.replicas,
    memoryMb: wanted.memoryMb,
    cpuMillicores: wanted.cpuMillicores,
    ...(wanted.port === null ? {} : { port: wanted.port }),
    ...(wanted.homeSite === null ? {} : { homeSite: wanted.homeSite }),
});

/** Only what differs from the Service, for the API; a problem when nothing does. */
export const servicePatch = (service: ServiceWanted, wanted: ServiceWanted): ServicePatch | string => {
    const patch: ServicePatch = {
        ...(wanted.image === service.image ? {} : { image: wanted.image }),
        ...(wanted.port === service.port ? {} : { port: wanted.port }),
        ...(wanted.replicas === service.replicas ? {} : { replicas: wanted.replicas }),
        ...(wanted.memoryMb === service.memoryMb ? {} : { memoryMb: wanted.memoryMb }),
        ...(wanted.cpuMillicores === service.cpuMillicores ? {} : { cpuMillicores: wanted.cpuMillicores }),
        ...(wanted.homeSite === service.homeSite ? {} : { homeSite: wanted.homeSite }),
    };
    return Object.keys(patch).length === 0 ? 'Nothing is changed. To run what the tag points at now, use Redeploy.' : patch;
};

/** `sha256:3fb9aafb2dd9…` as `3fb9aafb2dd9`: enough to tell two deploys apart. */
export const shortDigest = (digest: string): string => digest.replace(/^sha256:/, '').slice(0, 12);
