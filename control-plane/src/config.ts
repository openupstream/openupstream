/**
 * The control plane's settings, from its environment (control-plane/deploy).
 * Every problem is reported at once, before anything starts.
 */
import { DNS_LABEL } from '@openupstream/sdk';
import { BACKUP_ENDPOINT } from './backups.js';
import { retentionInterval } from './cleanup.js';
import type { GarageConfig } from './garage.js';
import { type Result, err, ok } from './result.js';

export interface Config {
    readonly databaseUrl: string;
    readonly port: number;
    readonly internalPort: number;
    readonly allowedCallers: ReadonlySet<string>;
    /** ServiceAccounts that may read Accounts and place or lift Holds: the billing service. None by default. */
    readonly billingCallers: ReadonlySet<string>;
    /** ServiceAccounts that may list the routing table: the Routes operator. */
    readonly routesCallers: ReadonlySet<string>;
    /** The Holds every new Account starts with, e.g. `payment-method`. None by default: no gate. */
    readonly newAccountHolds: readonly string[];
    readonly auth: {
        /** madAuth's public URL, the `iss` of its session tokens. */
        readonly issuer: string;
        /** madAuth inside the cluster: its JWKS and API key checks. */
        readonly madauthUrl: string;
        /** A JWKS document instead of madAuth's (tests). */
        readonly jwks?: string;
    };
    readonly backup: {
        readonly endpoint: string;
        readonly region: string;
        readonly bucket: string;
        readonly accessKeyId: string;
        readonly secretAccessKey: string;
        /** A Postgres interval, e.g. `7 days`. */
        readonly retention: string;
    };
    readonly garage: GarageConfig;
    /** Customer hostnames live under it, e.g. Buckets at `<bucket>.s3.<customerDomain>` (decision 68). */
    readonly customerDomain: string;
    /** Our own hostnames live under it (decision 67); like the customer domain, no Account may claim it. */
    readonly platformDomain: string;
    readonly cleanupIntervalMs: number;
}

/** The ServiceAccounts the internal API answers by default. */
export const DEFAULT_ALLOWED_CALLERS = ['system:serviceaccount:openupstream-system:databases-operator'];
export const DEFAULT_ROUTES_CALLERS = ['system:serviceaccount:openupstream-system:routes-operator'];

type Env = Readonly<Record<string, string | undefined>>;

/** JSON.parse only throws; this answers. */
const parseJson = (text: string): unknown => {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

const isJwks = (text: string): boolean => {
    const parsed = parseJson(text);
    return typeof parsed === 'object' && parsed !== null && 'keys' in parsed && Array.isArray(parsed.keys);
};

/** A comma-separated list, without empty entries. */
const list = (value: string | undefined): string[] => (value ?? '').split(',').map((item) => item.trim()).filter((item) => item !== '');

const port = (value: string | undefined, fallback: number): number | undefined => {
    const n = Number(value ?? fallback);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
};

export function configFrom(env: Env): Result<Config, string[]> {
    const problems: string[] = [];
    const required = (name: string): string => {
        const value = env[name];
        if (value === undefined || value === '') {
            problems.push(`${name} is not set`);
            return '';
        }
        return value;
    };
    const databaseUrl = required('DATABASE_URL');
    const issuer = required('AUTH_ISSUER');
    const madauthUrl = required('MADAUTH_URL');
    if (madauthUrl !== '' && !URL.canParse(madauthUrl)) {
        problems.push('MADAUTH_URL must be a URL');
    }
    const jwks = env['AUTH_JWKS'] ?? '';
    if (jwks !== '' && !isJwks(jwks)) {
        problems.push('AUTH_JWKS must be a JWKS document: {"keys": [...]}');
    }
    const bucket = required('BACKUP_BUCKET');
    const accessKeyId = required('ACCESS_KEY_ID');
    const secretAccessKey = required('ACCESS_SECRET_KEY');
    const retention = retentionInterval(required('BACKUP_RETENTION'));
    if (retention === undefined && env['BACKUP_RETENTION']) {
        problems.push('BACKUP_RETENTION must be days, e.g. 30d');
    }
    const garageAdminUrl = required('GARAGE_ADMIN_URL');
    const garageS3Url = required('GARAGE_S3_URL');
    if ([garageAdminUrl, garageS3Url].some((url) => url !== '' && !URL.canParse(url))) {
        problems.push('GARAGE_ADMIN_URL and GARAGE_S3_URL must be URLs');
    }
    const garageAdminToken = required('GARAGE_ADMIN_TOKEN');
    const domainName = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
    const customerDomain = required('CUSTOMER_DOMAIN');
    if (customerDomain !== '' && !domainName.test(customerDomain)) {
        problems.push('CUSTOMER_DOMAIN must be a domain name, e.g. openupstream.app');
    }
    const platformDomain = required('PLATFORM_DOMAIN');
    if (platformDomain !== '' && !domainName.test(platformDomain)) {
        problems.push('PLATFORM_DOMAIN must be a domain name, e.g. openupstream.com');
    }
    const publicPort = port(env['PORT'], 8080);
    const internalPort = port(env['INTERNAL_PORT'], 8081);
    if (publicPort === undefined || internalPort === undefined) {
        problems.push('PORT and INTERNAL_PORT must be port numbers');
    }
    const newAccountHolds = list(env['NEW_ACCOUNT_HOLDS']);
    if (!newAccountHolds.every((reason) => DNS_LABEL.test(reason))) {
        problems.push('NEW_ACCOUNT_HOLDS must be reasons that are DNS labels, e.g. payment-method');
    }
    const cleanupSeconds = Number(env['CLEANUP_INTERVAL_SECONDS'] ?? 30);
    if (!Number.isFinite(cleanupSeconds) || cleanupSeconds < 1) {
        problems.push('CLEANUP_INTERVAL_SECONDS must be a number of seconds, at least 1');
    }
    if (problems.length > 0 || retention === undefined || publicPort === undefined || internalPort === undefined) {
        return err(problems);
    }
    return ok({
        databaseUrl,
        port: publicPort,
        internalPort,
        allowedCallers: new Set(list(env['ALLOWED_CALLERS'] ?? DEFAULT_ALLOWED_CALLERS.join(','))),
        billingCallers: new Set(list(env['BILLING_CALLERS'])),
        routesCallers: new Set(list(env['ROUTES_CALLERS'] ?? DEFAULT_ROUTES_CALLERS.join(','))),
        newAccountHolds,
        auth: { issuer, madauthUrl, ...(jwks === '' ? {} : { jwks }) },
        backup: {
            endpoint: env['BACKUP_ENDPOINT'] ?? BACKUP_ENDPOINT,
            region: env['BACKUP_REGION'] ?? 'nbg1',
            bucket,
            accessKeyId,
            secretAccessKey,
            retention,
        },
        garage: { adminUrl: garageAdminUrl, adminToken: garageAdminToken, s3Url: garageS3Url },
        customerDomain,
        platformDomain,
        cleanupIntervalMs: cleanupSeconds * 1000,
    });
}
