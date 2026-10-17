/**
 * The control plane's settings, from its environment (control-plane/deploy).
 * Every problem is reported at once, before anything starts.
 */
import { BACKUP_ENDPOINT } from './backups.js';
import { retentionInterval } from './cleanup.js';
import { type Result, err, ok } from './result.js';

export interface Config {
    readonly databaseUrl: string;
    readonly port: number;
    readonly internalPort: number;
    readonly allowedCallers: ReadonlySet<string>;
    readonly auth: {
        readonly issuer: string;
        readonly audience: string;
        readonly jwksUrl?: string;
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
    readonly cleanupIntervalMs: number;
}

/** The ServiceAccounts the internal API answers by default. */
export const DEFAULT_ALLOWED_CALLERS = ['system:serviceaccount:openupstream-system:databases-operator'];

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
    const audience = required('AUTH_AUDIENCE');
    const jwksUrl = env['AUTH_JWKS_URL'] ?? '';
    const jwks = env['AUTH_JWKS'] ?? '';
    if ((jwksUrl === '') === (jwks === '')) {
        problems.push('set exactly one of AUTH_JWKS_URL and AUTH_JWKS');
    } else if (jwks !== '' && !isJwks(jwks)) {
        problems.push('AUTH_JWKS must be a JWKS document: {"keys": [...]}');
    } else if (jwksUrl !== '' && !URL.canParse(jwksUrl)) {
        problems.push('AUTH_JWKS_URL must be a URL');
    }
    const bucket = required('BACKUP_BUCKET');
    const accessKeyId = required('ACCESS_KEY_ID');
    const secretAccessKey = required('ACCESS_SECRET_KEY');
    const retention = retentionInterval(required('BACKUP_RETENTION'));
    if (retention === undefined && env['BACKUP_RETENTION']) {
        problems.push('BACKUP_RETENTION must be days, e.g. 30d');
    }
    const publicPort = port(env['PORT'], 8080);
    const internalPort = port(env['INTERNAL_PORT'], 8081);
    if (publicPort === undefined || internalPort === undefined) {
        problems.push('PORT and INTERNAL_PORT must be port numbers');
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
        allowedCallers: new Set(
            (env['ALLOWED_CALLERS'] ?? DEFAULT_ALLOWED_CALLERS.join(',')).split(',').filter((name) => name !== ''),
        ),
        auth: { issuer, audience, ...(jwksUrl === '' ? { jwks } : { jwksUrl }) },
        backup: {
            endpoint: env['BACKUP_ENDPOINT'] ?? BACKUP_ENDPOINT,
            region: env['BACKUP_REGION'] ?? 'nbg1',
            bucket,
            accessKeyId,
            secretAccessKey,
            retention,
        },
        cleanupIntervalMs: cleanupSeconds * 1000,
    });
}
