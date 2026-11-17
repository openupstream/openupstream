#!/usr/bin/env node
/**
 * oup, the openupstream CLI.
 *
 *   oup login [--api <url>] [--no-browser]   sign in through the browser (device grant)
 *   oup logout
 *   oup project list | create <name> [--account <name|id>] [--link]
 *   oup link <project>                       this directory's Project (.openupstream.json)
 *   oup member list | role <email> owner|developer | remove <email> | leave [--account <name|id>]
 *   oup pg list | show <name> | delete <name>
 *   oup pg create <name> [--memory <MB>] [--storage <GB>] [--site …]   waits until ready
 *   oup pg restore <source> <name> [--time <RFC 3339>] …   a new Database as a copy of <source>
 *   oup pg resize <name> [--memory <MB>] [--storage <GB>]   storage only grows
 *   oup pg proxy <name> [--access read|write|owner] [--port <n>]   the Database on this machine
 *   oup service list | show <name> | delete <name>
 *   oup service deploy <name> --image <ref> [--port … | --no-port] …
 *   oup service logs <name> [--tail <n>] [-f] [--timestamps]
 *   oup job list | show <name> | runs <name> | delete <name>
 *   oup job deploy <name> --image <ref> [--schedule …] … [-- command…]
 *   oup job run <name> [--env NAME=value] [-- args…]   waits for the outcome
 *   oup job stop <name> <run>
 *   oup job logs <name> [<run>] [--tail <n>] [-f] [--timestamps]   the newest run by default
 *   oup secret list | set <NAME> | delete <NAME>   a value is read from stdin
 *   oup bucket list | create <name> | show <name> | show-access-key <name> | export-env <name> [--file <path>] | delete <name>
 *   oup domain list | add <hostname> | verify <hostname> | delete <hostname>
 *   oup route list | add <address> --bucket <name> [--spa] | add <address> --service <name> | delete <address>
 *   oup usage [--instances] [--json]   what the Project's Resources use now
 *   oup site deploy <dir> --bucket <name> [--keep] [--force]
 *   oup version
 *
 * Database, service, job, secret, bucket, domain, route and usage commands act on the linked Project; `--project`
 * or `OUP_PROJECT` names another.
 *
 * `OUP_API_KEY` (a madAuth API key) replaces `oup login`, e.g. in CI, with
 * `OUP_API_URL` for another API than https://console.openupstream.com/api.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { S3Client } from '@aws-sdk/client-s3';
import {
    COMPUTE_SITES,
    DEFAULT_API_URL,
    type Account,
    type ApiResult,
    type Bucket,
    type BucketDetails,
    type Domain,
    type JobDetails,
    type LogEntry,
    OpenUpstreamClient,
    type Project,
    type RegistryAuth,
    type Route,
    SDK_VERSION,
    type ServiceDetails,
    type Site,
    cliLogin,
} from '@openupstream/sdk';
import { bucketEnv, bucketIn, mergeEnv, s3Endpoint } from './buckets.js';
import { credentialsPath, readCredentials, removeCredentials, writeCredentials } from './credentials.js';
import { deploy } from './deploy.js';
import { discover, emailOf, startDeviceSignIn, waitForApproval } from './oidc.js';
import { accountFor, findLink, formatProjects, projectFor, resolveProject, writeLink } from './project.js';
import { LAST_OWNER_HINT, formatMembers, memberByEmail, parseRole } from './members.js';
import {
    type DesiredJob,
    JOB_FLAGS,
    formatJobs,
    formatRuns,
    isFinished,
    outcomeOf,
    parseEnv,
    planJobDeploy,
    splitAtDashes,
    strayFlag,
} from './jobs.js';
import { formatLogEntry, parseTail } from './logs.js';
import { DATABASE_DEFAULTS, formatDatabases, growthOf, growthSettings, planRestore } from './databases.js';
import { type DesiredService, formatServices, planServiceDeploy, waitUntilRunning } from './services.js';
import { LISTEN_HOST, connectionUrl, listen, parseAccess, parsePort, portFree, prepareRole, serveTunnel } from './proxy.js';
import { dnsRecords, domainNamed, formatDomains, formatRoutes, hostnameOf, hostnameProblem, ingressOf, parseAddress, routeInput, routeRefusal } from './routes.js';
import { apiAccess } from './session.js';
import { readSecretValue } from './stdin.js';
import { waitUntil } from './wait.js';
import { formatUsage } from './usage.js';
import { CLI_VERSION } from './version.js';

const USAGE = `usage:
  oup login [--api <url>] [--no-browser]
  oup logout
  oup project list
  oup project create <name> [--account <name|id>] [--link]
  oup link <project>
  oup member list [--account <name|id>]
  oup member role <email> owner|developer [--account <name|id>]
  oup member remove <email> [--account <name|id>]
  oup member leave [--account <name|id>]
  oup pg list
  oup pg show <name>
  oup pg create <name> [--memory <MB>] [--storage <GB>] [--site hetzner-fsn1|ovh-lim] [--max-storage <GB> | --no-auto-grow] [--no-wait]
  oup pg restore <source> <name> [--time <RFC 3339>] [--memory <MB>] [--storage <GB>] [--site …] [--max-storage <GB> | --no-auto-grow] [--no-wait]
  oup pg resize <name> [--memory <MB>] [--storage <GB>] [--max-storage <GB> | --no-max-storage] [--auto-grow | --no-auto-grow] [--no-wait]
  oup pg delete <name>
  oup pg proxy <name> [--access read|write|owner] [--port <n>]
  oup service list
  oup service show <name>
  oup service deploy <name> --image <ref> [--port <n> | --no-port] [--replicas <n>] [--memory <MB>] [--cpu <millicores>]
                     [--site hetzner-fsn1|ovh-lim] [--registry-user <user> --registry-password-stdin] [--no-wait]
  oup service logs <name> [--tail <n>] [-f | --follow] [--timestamps]
  oup service delete <name>
  oup job list
  oup job show <name>
  oup job deploy <name> --image <ref> [--schedule <cron> | --no-schedule] [--time-zone <IANA name>]
                 [--timeout <seconds>] [--memory <MB>] [--cpu <millicores>] [--site hetzner-fsn1|ovh-lim]
                 [--registry-user <user> --registry-password-stdin] [--no-wait] [--no-command | -- <command> <arg>…]
  oup job run <name> [--env NAME=value]… [--no-wait] [-- <arg>…]
  oup job runs <name>
  oup job stop <name> <run>
  oup job logs <name> [<run>] [--tail <n>] [-f | --follow] [--timestamps]
  oup job delete <name>
  oup secret list
  oup secret set <NAME>        (the value from stdin)
  oup secret delete <NAME>
  oup bucket list
  oup bucket create <name>
  oup bucket show <name>
  oup bucket show-access-key <name>           (prints the Bucket's secret access key)
  oup bucket export-env <name> [--file <path>] (writes it into an env file, default .env)
  oup bucket delete <name>
  oup domain list
  oup domain add <hostname>                    (a custom domain; prints the DNS records to publish)
  oup domain verify <hostname>
  oup domain delete <hostname>                 (and its Routes)
  oup route list
  oup route add <address> --bucket <name> [--spa]
  oup route add <address> --service <name>
  oup route delete <address>
               <address> is <hostname>/<path>, or /<path> alone for the Project's default Domain
  oup usage [--instances] [--json]
  oup site deploy <dir> --bucket <name> [--keep] [--force]
  oup version

Database, service, job, secret, bucket, domain, route and usage commands take --project <name|id>; without
it, the Project linked to this directory (oup link) or OUP_PROJECT.

pg create gives a Database 256 MB and 1 GB unless told otherwise. pg restore
creates a new Database that starts as a copy of <source> at --time, or at
the latest point its backups reach; <source> keeps running. Its size and
Site default to the source's. A deleted Database can be restored by its id
(oup pg delete prints it) within the backup retention window, with --storage.
Storage grows by itself by half once 90% full, without a limit unless
--max-storage sets one; --no-auto-grow leaves it to pg resize.
pg resize grows the storage online; a new memory size restarts the
instances one after the other (writes pause for seconds).
pg proxy reaches the Database from this machine while it runs: it listens on
127.0.0.1:5432 (--port for another) and prints the URL to connect with. You
log in with a Postgres role of your own: --access read (the default) reads
every table, write also changes rows, owner acts as app, the role the
Project's Services use, so migrations work; owner connections go to the
primary, so migration tools' locks work, at most 5 at once.

member acts on your only Account, or on --account. An owner may do
everything, the Account's Members included; a developer every Project and
everything in it. Only owners change roles and remove Members; anyone may
leave. An Account always keeps an owner. A removed Member's Postgres roles
are dropped. These commands need oup login: an API key cannot change who is
in an Account.

logs prints the last lines (100 by default) of every replica or of a run,
with -f also new ones as they are written, for up to an hour. Nothing is
kept: what a pod wrote before it was replaced is gone.`;

const fail = (message: string): never => {
    console.error(`oup: ${message}`);
    process.exit(1);
};

/** Opens `url` in the browser on this machine; not over SSH, where there is none to open. */
const openBrowser = (url: string): boolean => {
    if (process.env['SSH_CONNECTION'] !== undefined) {
        return false;
    }
    const [command, ...args] =
        process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '""', url] : ['xdg-open', url];
    const child = spawn(command as string, args, { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
    return true;
};

async function login(args: string[]): Promise<void> {
    const { values } = parseArgs({ args, options: { api: { type: 'string' }, 'no-browser': { type: 'boolean' } } });
    const apiUrl = values.api ?? process.env['OUP_API_URL'] ?? DEFAULT_API_URL;
    const settings = await cliLogin(apiUrl);
    if (!settings.ok) {
        fail(settings.error.status === 404 ? `${apiUrl} has no CLI sign-in set up` : `cannot reach ${apiUrl}: ${settings.error.message}`);
        return;
    }
    const { issuer, clientId } = settings.value;
    const discovery = await discover(issuer);
    if (!discovery.ok) {
        return fail(`cannot reach madAuth: ${discovery.error}`);
    }
    const device = await startDeviceSignIn(discovery.value, clientId);
    if (!device.ok) {
        return fail(device.error);
    }
    const opened = !values['no-browser'] && openBrowser(device.value.verificationUriComplete);
    console.log(
        opened
            ? `Approve the sign-in in your browser; check that it shows the code ${device.value.userCode}.\nIf no browser opened, go to ${device.value.verificationUriComplete}`
            : `Open ${device.value.verificationUri} and enter the code ${device.value.userCode}\n(or go to ${device.value.verificationUriComplete})`,
    );
    const tokens = await waitForApproval(discovery.value, clientId, device.value);
    if (!tokens.ok) {
        return fail(tokens.error);
    }
    const email = emailOf(tokens.value.idToken);
    await writeCredentials(credentialsPath(), {
        apiUrl,
        issuer,
        clientId,
        refreshToken: tokens.value.refreshToken,
        accessToken: tokens.value.accessToken,
        accessTokenExpiresAt: tokens.value.expiresAt,
        ...(tokens.value.idToken === undefined ? {} : { idToken: tokens.value.idToken }),
        ...(email === undefined ? {} : { email }),
    });
    console.log(`Signed in${email === undefined ? '' : ` as ${email}`}.`);
}

/** Forgets the tokens here and ends the CLI's refresh tokens at madAuth. */
async function logout(): Promise<void> {
    const path = credentialsPath();
    const credentials = await readCredentials(path);
    await removeCredentials(path);
    if (credentials?.idToken !== undefined) {
        const discovery = await discover(credentials.issuer);
        if (discovery.ok && discovery.value.endSessionEndpoint !== undefined) {
            const url = new URL(discovery.value.endSessionEndpoint);
            url.searchParams.set('id_token_hint', credentials.idToken);
            await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
        }
    }
    console.log('Signed out.');
}

/** The API client for the signed-in user (or OUP_API_KEY). */
async function apiClient(): Promise<OpenUpstreamClient> {
    const access = await apiAccess(credentialsPath());
    if (!access.ok) {
        return fail(access.error);
    }
    return new OpenUpstreamClient({ baseUrl: access.value.apiUrl, token: access.value.token });
}

async function listProjects(client: OpenUpstreamClient): Promise<Project[]> {
    const projects = await client.listProjects();
    return projects.ok ? projects.value : fail(projects.error.message);
}

/** The client and the Project this command acts on: --project, OUP_PROJECT, or the linked one. */
async function inProject(flag: string | undefined): Promise<{ client: OpenUpstreamClient; project: Project }> {
    const client = await apiClient();
    const project = await projectFor(await listProjects(client), flag ?? process.env['OUP_PROJECT'], process.cwd());
    return project.ok ? { client, project: project.value } : fail(project.error);
}

async function listAccounts(client: OpenUpstreamClient): Promise<Account[]> {
    const accounts = await client.listAccounts();
    return accounts.ok ? accounts.value : fail(accounts.error.message);
}

/** `oup project list` and `oup project create`: the caller's Projects, and a new one in an Account of theirs. */
async function project(args: string[]): Promise<void> {
    const [verb, ...rest] = args;
    const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { account: { type: 'string' }, link: { type: 'boolean' } },
    });
    if (verb === 'list' && positionals.length === 0 && values.account === undefined && values.link === undefined) {
        const client = await apiClient();
        const [projects, accounts, found] = await Promise.all([listProjects(client), listAccounts(client), findLink(process.cwd())]);
        const lines = formatProjects(projects, accounts, found.ok ? found.value?.link.projectId : undefined);
        console.log(lines.length === 0 ? 'No Projects yet; oup project create <name> makes one.' : lines.join('\n'));
        return;
    }
    const [name, ...extra] = positionals;
    if (verb !== 'create' || name === undefined || extra.length > 0) {
        return fail(USAGE);
    }
    const client = await apiClient();
    const account = accountFor(await listAccounts(client), values.account);
    if (!account.ok) {
        return fail(account.error);
    }
    const created = await client.createProject({ accountId: account.value.id, name });
    if (!created.ok) {
        return fail(created.error.message);
    }
    console.log(`Created the Project ${created.value.name} (${created.value.id}) in the Account ${account.value.name}.`);
    if (values.link === true) {
        const path = await writeLink(process.cwd(), created.value);
        console.log(`Linked to it in ${path}.`);
        return;
    }
    console.log(`oup link ${created.value.name} makes the commands in a directory act on it.`);
}

async function link(args: string[]): Promise<void> {
    const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
    const [reference] = positionals;
    if (reference === undefined) {
        return fail(USAGE);
    }
    const project = resolveProject(await listProjects(await apiClient()), reference);
    if (!project.ok) {
        return fail(project.error);
    }
    const path = await writeLink(process.cwd(), project.value);
    console.log(`Linked to the Project ${project.value.name} (${project.value.id}) in ${path}.`);
}

/** A positive whole number from a flag; undefined when it was not given. */
const count = (flag: string, value: string | undefined): number | undefined => {
    if (value === undefined) {
        return undefined;
    }
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : fail(`--${flag} must be a positive whole number, not ${value}`);
};

const isSite = (value: string): value is Site => (COMPUTE_SITES as readonly string[]).includes(value);

/** A Database's flags of one verb that another verb does not take. */
const PG_FLAGS = {
    list: [],
    show: [],
    delete: [],
    create: ['memory', 'storage', 'site', 'no-wait', 'max-storage', 'no-auto-grow'],
    restore: ['memory', 'storage', 'site', 'no-wait', 'time', 'max-storage', 'no-auto-grow'],
    resize: ['memory', 'storage', 'no-wait', 'max-storage', 'no-max-storage', 'auto-grow', 'no-auto-grow'],
    proxy: ['access', 'port'],
} as const satisfies Record<string, readonly string[]>;

async function pg(args: string[]): Promise<void> {
    const [verb, ...rest] = args;
    const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
            project: { type: 'string' },
            memory: { type: 'string' },
            storage: { type: 'string' },
            site: { type: 'string' },
            time: { type: 'string' },
            'no-wait': { type: 'boolean' },
            'max-storage': { type: 'string' },
            'no-max-storage': { type: 'boolean' },
            'auto-grow': { type: 'boolean' },
            'no-auto-grow': { type: 'boolean' },
            access: { type: 'string' },
            port: { type: 'string' },
        },
    });
    if (verb === undefined || !Object.hasOwn(PG_FLAGS, verb)) {
        return fail(USAGE);
    }
    const allowed: readonly string[] = PG_FLAGS[verb as keyof typeof PG_FLAGS];
    const stray = Object.keys(values).find((flag) => flag !== 'project' && !allowed.includes(flag));
    if (stray !== undefined) {
        return fail(`oup pg ${verb} does not take --${stray}`);
    }
    const [name, second] = positionals;
    if ((verb !== 'list' && name === undefined) || (verb === 'restore' && second === undefined)) {
        return fail(USAGE);
    }
    if (values.site !== undefined && !isSite(values.site)) {
        return fail(`--site is one of ${COMPUTE_SITES.join(', ')}`);
    }
    const memoryMb = count('memory', values.memory);
    const storageGb = count('storage', values.storage);
    const homeSite = values.site !== undefined && isSite(values.site) ? values.site : undefined;
    const growth = growthSettings(values);
    if (!growth.ok) {
        return fail(growth.reason);
    }
    const { client, project } = await inProject(values.project);
    const databases = await client.listDatabases(project.id);
    if (!databases.ok) {
        return fail(databases.error.message);
    }
    const existing = databases.value.find((candidate) => candidate.name === name);
    const found = () => existing ?? fail(`no Database ${name} in ${project.name}`);
    switch (verb) {
        case 'list':
            console.log(databases.value.length === 0 ? `No Databases in ${project.name}.` : formatDatabases(databases.value).join('\n'));
            return;
        case 'show':
            return console.log(JSON.stringify(found(), null, 2));
        case 'delete': {
            const database = found();
            const deleted = await client.deleteDatabase(project.id, database.id);
            return deleted.ok
                ? console.log(
                      `Deleted ${name}. Its backups are kept for the retention window; until then\n  oup pg restore ${database.id} <name> --storage ${database.storageGb}\nbrings it back as a new Database.`,
                  )
                : fail(deleted.error.message);
        }
        case 'proxy':
            return pgProxy(client, project, found(), values.access, values.port);
        case 'resize': {
            const database = found();
            if (memoryMb === undefined && storageGb === undefined && Object.keys(growth.settings).length === 0) {
                return fail('oup pg resize needs --memory, --storage, --max-storage, --no-max-storage, --auto-grow or --no-auto-grow');
            }
            const resized = await client.updateDatabase(project.id, database.id, {
                ...(memoryMb === undefined ? {} : { memoryMb }),
                ...(storageGb === undefined ? {} : { storageGb }),
                ...growth.settings,
            });
            if (!resized.ok) {
                return fail(resized.error.message);
            }
            console.log(
                `${name}: ${database.memoryMb} → ${resized.value.memoryMb} MB, ${database.storageGb} → ${resized.value.storageGb} GB, storage grows ${growthOf(resized.value)}`,
            );
            // Only the growth settings changed: nothing to wait for.
            if (values['no-wait'] === true || (memoryMb === undefined && storageGb === undefined)) {
                return;
            }
            return waitReady(client, project.id, database.id, name as string);
        }
        case 'create':
        case 'restore': {
            const planned =
                verb === 'create'
                    ? {
                          ok: true as const,
                          input: {
                              name: name as string,
                              memoryMb: memoryMb ?? DATABASE_DEFAULTS.memoryMb,
                              storageGb: storageGb ?? DATABASE_DEFAULTS.storageGb,
                              ...(homeSite === undefined ? {} : { homeSite }),
                          },
                      }
                    : planRestore(databases.value, {
                          source: name as string,
                          name: second as string,
                          ...(values.time === undefined ? {} : { time: values.time }),
                          ...(memoryMb === undefined ? {} : { memoryMb }),
                          ...(storageGb === undefined ? {} : { storageGb }),
                          ...(homeSite === undefined ? {} : { homeSite }),
                      });
            if (!planned.ok) {
                return fail(planned.reason);
            }
            const created = await client.createDatabase(project.id, { ...planned.input, ...growth.settings });
            if (!created.ok) {
                return fail(created.error.message);
            }
            const { name: createdName, memoryMb: mb, storageGb: gb, homeSite: site, id } = created.value;
            console.log(`${verb === 'create' ? 'Created' : 'Restoring into'} ${createdName}: ${mb} MB, ${gb} GB (grows ${growthOf(created.value)}), primary in ${site}`);
            if (values['no-wait'] === true) {
                return;
            }
            return waitReady(client, project.id, id, createdName);
        }
        default:
            return fail(USAGE);
    }
}

/**
 * `oup pg proxy`: the caller's own role, a first login through the tunnel
 * (which waits for the role and, at owner, makes it act as app), then the
 * local port, until Ctrl-C.
 */
async function pgProxy(
    client: OpenUpstreamClient,
    project: Project,
    database: { readonly id: string; readonly name: string },
    accessFlag: string | undefined,
    portFlag: string | undefined,
): Promise<void> {
    const access = parseAccess(accessFlag);
    const port = parsePort(portFlag);
    if (!access.ok || !port.ok) {
        return fail(!access.ok ? access.error : !port.ok ? port.error : '');
    }
    // A taken port is said before any waiting.
    const free = await portFree(port.value);
    if (!free.ok) {
        return fail(free.error);
    }
    const proxy = await client.openDatabaseProxy(project.id, database.id, { access: access.value });
    if (!proxy.ok) {
        return fail(proxy.error.message);
    }
    const token = async () => {
        const fresh = await apiAccess(credentialsPath());
        return fresh.ok ? { ok: true as const, value: fresh.value.token } : fresh;
    };
    const tunnel = { url: proxy.value.tunnelUrl, token, warn: (message: string) => console.error(`oup: ${message}`) };
    const prepared = await prepareRole({ ...tunnel, proxy: proxy.value, report: (message) => console.log(message) });
    if (!prepared.ok) {
        return fail(prepared.error);
    }
    const server = createServer();
    serveTunnel(server, tunnel);
    const listening = await listen(server, port.value);
    if (!listening.ok) {
        return fail(listening.error);
    }
    // Once listening, an error of the server (too many open files) is said, and the proxy goes on.
    server.on('error', (error) => console.error(`oup: ${error.message}`));
    console.log(`${database.name} (${access.value}) on ${LISTEN_HOST}:${port.value}. Connect with:`);
    console.log(`  ${connectionUrl(proxy.value, port.value)}`);
    console.log('Press Ctrl-C to stop.');
    await once(process, 'SIGINT');
    server.close();
    process.exit(0);
}

/** Until the Database is ready; every state it passes through is reported once. */
async function waitReady(client: OpenUpstreamClient, projectId: string, databaseId: string, name: string): Promise<void> {
    // A restore first fetches the base backup and replays WAL; a new memory size restarts both instances.
    const ready = await waitUntil(() => client.getDatabase(projectId, databaseId), (database) => database.state === 'ready', {
        timeoutMs: 20 * 60_000,
        intervalMs: 5_000,
        report: (state) => console.log(`  ${state}`),
    });
    return ready.ok ? undefined : fail(`${name} is not ready: ${ready.error}`);
}

async function service(args: string[]): Promise<void> {
    const [verb, ...rest] = args;
    const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
            project: { type: 'string' },
            image: { type: 'string' },
            port: { type: 'string' },
            'no-port': { type: 'boolean' },
            replicas: { type: 'string' },
            memory: { type: 'string' },
            cpu: { type: 'string' },
            site: { type: 'string' },
            'registry-user': { type: 'string' },
            'registry-password-stdin': { type: 'boolean' },
            'no-wait': { type: 'boolean' },
            tail: { type: 'string' },
            follow: { type: 'boolean', short: 'f' },
            timestamps: { type: 'boolean' },
        },
    });
    const [name] = positionals;
    if (verb !== 'list' && name === undefined) {
        return fail(USAGE);
    }
    const logFlag = (['tail', 'follow', 'timestamps'] as const).find((flag) => values[flag] !== undefined);
    if (verb !== 'logs' && logFlag !== undefined) {
        return fail(`oup service ${verb} does not take --${logFlag}`);
    }
    const { client, project } = await inProject(values.project);
    const services = await client.listServices(project.id);
    if (!services.ok) {
        return fail(services.error.message);
    }
    const existing = services.value.find((candidate) => candidate.name === name);
    switch (verb) {
        case 'list':
            console.log(services.value.length === 0 ? `No Services in ${project.name}.` : formatServices(services.value).join('\n'));
            return;
        case 'show':
            return existing === undefined ? fail(`no Service ${name} in ${project.name}`) : console.log(JSON.stringify(existing, null, 2));
        case 'delete': {
            if (existing === undefined) {
                return fail(`no Service ${name} in ${project.name}`);
            }
            const deleted = await client.deleteService(project.id, existing.id);
            return deleted.ok ? console.log(`Deleted ${name}; its pods stop within a minute.`) : fail(deleted.error.message);
        }
        case 'deploy':
            return serviceDeploy(client, project, existing, { ...values, name: name as string });
        case 'logs': {
            if (existing === undefined) {
                return fail(`no Service ${name} in ${project.name}`);
            }
            const tail = parseTail(values.tail);
            if (!tail.ok) {
                return fail(tail.error);
            }
            return printLogs(await client.serviceLogs(project.id, existing.id, logQuery(tail.value, values.follow)), {
                prefix: true,
                timestamps: values.timestamps === true,
            });
        }
        default:
            return fail(USAGE);
    }
}

async function serviceDeploy(
    client: OpenUpstreamClient,
    project: Project,
    existing: Parameters<typeof planServiceDeploy>[0],
    flags: { name: string; image?: string; port?: string; 'no-port'?: boolean; replicas?: string; memory?: string; cpu?: string; site?: string; 'registry-user'?: string; 'registry-password-stdin'?: boolean; 'no-wait'?: boolean },
): Promise<void> {
    if (flags.image === undefined) {
        return fail('oup service deploy needs --image');
    }
    if (flags.site !== undefined && !isSite(flags.site)) {
        return fail(`--site is one of ${COMPUTE_SITES.join(', ')}`);
    }
    if (flags.port !== undefined && flags['no-port'] === true) {
        return fail('--port and --no-port exclude each other');
    }
    const registryAuth = await registryAuthFrom(flags);
    const port = flags['no-port'] === true ? null : count('port', flags.port);
    const replicas = count('replicas', flags.replicas);
    const memoryMb = count('memory', flags.memory);
    const cpuMillicores = count('cpu', flags.cpu);
    const desired: DesiredService = {
        name: flags.name,
        image: flags.image,
        ...(port === undefined ? {} : { port }),
        ...(replicas === undefined ? {} : { replicas }),
        ...(memoryMb === undefined ? {} : { memoryMb }),
        ...(cpuMillicores === undefined ? {} : { cpuMillicores }),
        ...(flags.site === undefined || !isSite(flags.site) ? {} : { homeSite: flags.site }),
        ...(registryAuth === undefined ? {} : { registryAuth }),
    };
    const plan = planServiceDeploy(existing, desired);
    const deployed =
        plan.kind === 'invalid'
            ? fail(plan.reason)
            : plan.kind === 'create'
              ? await client.createService(project.id, plan.input)
              : plan.kind === 'update'
                ? await client.updateService(project.id, plan.serviceId, plan.patch)
                : await client.deployService(project.id, plan.serviceId);
    if (!deployed.ok) {
        return fail(deployed.error.message);
    }
    const verb = plan.kind === 'create' ? 'Created' : plan.kind === 'update' ? 'Changed' : 'Deployed';
    console.log(`${verb} ${flags.name}: ${deployed.value.image} at ${deployed.value.imageDigest}`);
    if (flags['no-wait'] === true) {
        return;
    }
    const running = await waitUntilRunning(() => client.getService(project.id, deployed.value.id), {
        timeoutMs: 5 * 60_000,
        intervalMs: 3_000,
        report: (state) => console.log(`  ${state}`),
    });
    return running.ok ? undefined : fail(`${flags.name} is not running: ${running.error}`);
}

const logQuery = (tail: number | undefined, follow: boolean | undefined) => ({
    ...(tail === undefined ? {} : { tail }),
    ...(follow === true ? { follow: true } : {}),
});

/** Prints a log stream as it arrives. */
async function printLogs(opened: ApiResult<AsyncIterable<LogEntry>>, options: { readonly prefix: boolean; readonly timestamps: boolean }): Promise<void> {
    if (!opened.ok) {
        return fail(opened.error.message);
    }
    for await (const entry of opened.value) {
        console.log(formatLogEntry(entry, options));
    }
}

/** Registry credentials from `--registry-user` and the password on stdin; undefined without them. */
async function registryAuthFrom(flags: { 'registry-user'?: string; 'registry-password-stdin'?: boolean }): Promise<RegistryAuth | undefined> {
    const username = flags['registry-user'];
    if ((username === undefined) !== (flags['registry-password-stdin'] !== true)) {
        return fail('--registry-user and --registry-password-stdin go together');
    }
    if (username === undefined) {
        return undefined;
    }
    const password = await readSecretValue('Registry password: ');
    return password === undefined || password === '' ? fail('no registry password on stdin') : { username, password };
}

async function job(args: string[]): Promise<void> {
    const [verb, ...rest] = args;
    // After `--`: the command of `deploy`, the args of `run`; never flags.
    const { flags, rest: trailing } = splitAtDashes(rest);
    const { values, positionals } = parseArgs({
        args: flags,
        allowPositionals: true,
        options: {
            project: { type: 'string' },
            image: { type: 'string' },
            schedule: { type: 'string' },
            'no-schedule': { type: 'boolean' },
            'time-zone': { type: 'string' },
            timeout: { type: 'string' },
            memory: { type: 'string' },
            cpu: { type: 'string' },
            site: { type: 'string' },
            'no-command': { type: 'boolean' },
            env: { type: 'string', multiple: true },
            'registry-user': { type: 'string' },
            'registry-password-stdin': { type: 'boolean' },
            'no-wait': { type: 'boolean' },
            tail: { type: 'string' },
            follow: { type: 'boolean', short: 'f' },
            timestamps: { type: 'boolean' },
        },
    });
    const [name, runId] = positionals;
    if (verb === undefined || !Object.hasOwn(JOB_FLAGS, verb) || (verb !== 'list' && name === undefined)) {
        return fail(USAGE);
    }
    const stray = strayFlag(verb as keyof typeof JOB_FLAGS, values);
    if (stray !== undefined || (trailing !== undefined && verb !== 'deploy' && verb !== 'run')) {
        return fail(`oup job ${verb} does not take ${stray === undefined ? 'arguments after --' : `--${stray}`}`);
    }
    const { client, project } = await inProject(values.project);
    const jobs = await client.listJobs(project.id);
    if (!jobs.ok) {
        return fail(jobs.error.message);
    }
    const existing = jobs.value.find((candidate) => candidate.name === name);
    const found = (): JobDetails => existing ?? fail(`no Job ${name} in ${project.name}`);
    switch (verb) {
        case 'list':
            console.log(jobs.value.length === 0 ? `No Jobs in ${project.name}.` : formatJobs(jobs.value).join('\n'));
            return;
        case 'show':
            return console.log(JSON.stringify(found(), null, 2));
        case 'runs': {
            const runs = await client.listJobRuns(project.id, found().id);
            if (!runs.ok) {
                return fail(runs.error.message);
            }
            console.log(runs.value.length === 0 ? `No runs of ${name} in the last day.` : formatRuns(runs.value).join('\n'));
            return;
        }
        case 'stop': {
            if (runId === undefined) {
                return fail(USAGE);
            }
            const stopped = await client.deleteJobRun(project.id, found().id, runId);
            return stopped.ok ? console.log(`Stopped and removed ${runId}.`) : fail(stopped.error.message);
        }
        case 'logs': {
            const tail = parseTail(values.tail);
            if (!tail.ok) {
                return fail(tail.error);
            }
            const jobId = found().id;
            const run = runId ?? (await newestRun(client, project, jobId, name as string));
            return printLogs(await client.jobRunLogs(project.id, jobId, run, logQuery(tail.value, values.follow)), {
                prefix: false,
                timestamps: values.timestamps === true,
            });
        }
        case 'delete': {
            const deleted = await client.deleteJob(project.id, found().id);
            return deleted.ok ? console.log(`Deleted ${name}; its runs stop within a minute.`) : fail(deleted.error.message);
        }
        case 'deploy':
            return jobDeploy(client, project, existing, { ...values, name: name as string, command: trailing });
        case 'run':
            return jobRun(client, project, found(), { env: values.env ?? [], args: trailing, wait: values['no-wait'] !== true });
        default:
            return fail(USAGE);
    }
}

/** The id of the Job's newest run; the API lists them newest first. */
async function newestRun(client: OpenUpstreamClient, project: Project, jobId: string, name: string): Promise<string> {
    const runs = await client.listJobRuns(project.id, jobId);
    if (!runs.ok) {
        return fail(runs.error.message);
    }
    return runs.value[0]?.id ?? fail(`no runs of ${name} in the last day`);
}

async function jobDeploy(
    client: OpenUpstreamClient,
    project: Project,
    existing: JobDetails | undefined,
    flags: {
        name: string;
        command: string[] | undefined;
        image?: string;
        schedule?: string;
        'no-schedule'?: boolean;
        'time-zone'?: string;
        timeout?: string;
        memory?: string;
        cpu?: string;
        site?: string;
        'no-command'?: boolean;
        'registry-user'?: string;
        'registry-password-stdin'?: boolean;
        'no-wait'?: boolean;
    },
): Promise<void> {
    if (flags.image === undefined) {
        return fail('oup job deploy needs --image');
    }
    if (flags.command !== undefined && flags['no-command'] === true) {
        return fail('a command after -- and --no-command exclude each other');
    }
    if (flags.schedule !== undefined && flags['no-schedule'] === true) {
        return fail('--schedule and --no-schedule exclude each other');
    }
    if (flags.site !== undefined && !isSite(flags.site)) {
        return fail(`--site is one of ${COMPUTE_SITES.join(', ')}`);
    }
    if (flags.command !== undefined && flags.command.length === 0) {
        return fail('nothing after --; leave it out to keep the command');
    }
    const registryAuth = await registryAuthFrom(flags);
    const timeoutSeconds = count('timeout', flags.timeout);
    const memoryMb = count('memory', flags.memory);
    const cpuMillicores = count('cpu', flags.cpu);
    const schedule = flags['no-schedule'] === true ? null : flags.schedule;
    const desired: DesiredJob = {
        name: flags.name,
        image: flags.image,
        ...(flags['no-command'] === true ? { command: null } : flags.command === undefined ? {} : { command: flags.command }),
        ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
        ...(memoryMb === undefined ? {} : { memoryMb }),
        ...(cpuMillicores === undefined ? {} : { cpuMillicores }),
        ...(schedule === undefined ? {} : { schedule }),
        ...(flags['time-zone'] === undefined ? {} : { timeZone: flags['time-zone'] }),
        ...(flags.site === undefined || !isSite(flags.site) ? {} : { homeSite: flags.site }),
        ...(registryAuth === undefined ? {} : { registryAuth }),
    };
    const plan = planJobDeploy(existing, desired);
    const deployed =
        plan.kind === 'create'
            ? await client.createJob(project.id, plan.input)
            : plan.kind === 'update'
              ? await client.updateJob(project.id, plan.jobId, plan.patch)
              : await client.deployJob(project.id, plan.jobId);
    if (!deployed.ok) {
        return fail(deployed.error.message);
    }
    const verb = plan.kind === 'create' ? 'Created' : plan.kind === 'update' ? 'Changed' : 'Deployed';
    const when = deployed.value.schedule === null ? 'on demand' : `on ${deployed.value.schedule} (${deployed.value.timeZone ?? 'UTC'})`;
    console.log(`${verb} ${flags.name}, ${when}: ${deployed.value.image} at ${deployed.value.imageDigest}`);
    if (flags['no-wait'] === true) {
        return;
    }
    const ready = await waitUntil(() => client.getJob(project.id, deployed.value.id), (current) => current.state === 'ready', {
        timeoutMs: 2 * 60_000,
        intervalMs: 3_000,
        report: (state) => console.log(`  ${state}`),
    });
    return ready.ok ? undefined : fail(`${flags.name} is not ready: ${ready.error}`);
}

/** Starts a One-off job and, unless told not to, waits for its outcome: exit 1 when it failed. */
async function jobRun(
    client: OpenUpstreamClient,
    project: Project,
    target: JobDetails,
    options: { readonly env: readonly string[]; readonly args: readonly string[] | undefined; readonly wait: boolean },
): Promise<void> {
    const env = parseEnv(options.env);
    if (!env.ok) {
        return fail(env.error);
    }
    const started = await client.startJobRun(project.id, target.id, {
        ...(options.args === undefined ? {} : { args: [...options.args] }),
        ...(Object.keys(env.value).length === 0 ? {} : { env: env.value }),
    });
    if (!started.ok) {
        return fail(started.error.message);
    }
    console.log(`Started ${started.value.id}`);
    if (!options.wait) {
        return;
    }
    // Pulling the image and scheduling the pod come before the Job's own timeout starts.
    const finished = await waitUntil(() => client.getJobRun(project.id, target.id, started.value.id), isFinished, {
        timeoutMs: (target.timeoutSeconds + 5 * 60) * 1000,
        intervalMs: 2_000,
        report: (state) => console.log(`  ${state}`),
    });
    if (!finished.ok) {
        return fail(`${started.value.id}: ${finished.error}`);
    }
    const outcome = outcomeOf(finished.value);
    return finished.value.state === 'succeeded' ? console.log(outcome) : fail(`${started.value.id} ${outcome}`);
}

async function secret(args: string[]): Promise<void> {
    const [verb, ...rest] = args;
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { project: { type: 'string' } } });
    const [name] = positionals;
    if (verb !== 'list' && name === undefined) {
        return fail(USAGE);
    }
    const { client, project } = await inProject(values.project);
    switch (verb) {
        case 'list': {
            const secrets = await client.listSecrets(project.id);
            if (!secrets.ok) {
                return fail(secrets.error.message);
            }
            console.log(secrets.value.length === 0 ? `No Secrets in ${project.name}.` : secrets.value.map((s) => `${s.name.padEnd(32)} ${s.updatedAt}`).join('\n'));
            return;
        }
        case 'set': {
            const value = await readSecretValue(`Value of ${name}: `);
            if (value === undefined) {
                return fail('cancelled');
            }
            // Most likely a pipe that was forgotten (CI, </dev/null); an empty value would replace the real one.
            if (value === '') {
                return fail(`no value for ${name} on stdin; pipe it in, e.g. printf %s "$VALUE" | oup secret set ${name}`);
            }
            const stored = await client.putSecret(project.id, { name: name as string, value });
            return stored.ok ? console.log(`Set ${name} in ${project.name}; its Services restart with it.`) : fail(stored.error.message);
        }
        case 'delete': {
            const deleted = await client.deleteSecret(project.id, name as string);
            return deleted.ok ? console.log(`Deleted ${name} from ${project.name}.`) : fail(deleted.error.message);
        }
        default:
            return fail(USAGE);
    }
}

/**
 * `oup bucket`: the linked Project's Buckets. Only `show-access-key` prints
 * the Bucket's secret, and `export-env` writes it into a file without
 * showing it (decision 133).
 */
async function bucket(args: string[]): Promise<void> {
    const [verb, ...rest] = args;
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { project: { type: 'string' }, file: { type: 'string' } } });
    const [name] = positionals;
    if (verb === undefined || (verb !== 'list' && name === undefined) || (values.file !== undefined && verb !== 'export-env')) {
        return fail(USAGE);
    }
    const { client, project } = await inProject(values.project);
    const list = async (): Promise<Bucket[]> => {
        const buckets = await client.listBuckets(project.id);
        return buckets.ok ? buckets.value : fail(buckets.error.message);
    };
    /** The Bucket `name` of the Project, for the verbs that act on one. */
    const named = async (): Promise<Bucket> => (await list()).find((candidate) => candidate.name === name) ?? fail(`no Bucket ${name} in ${project.name}`);
    /** The same with its access. */
    const details = async (): Promise<BucketDetails> => {
        const read = await client.getBucket(project.id, (await named()).id);
        return read.ok ? read.value : fail(read.error.message);
    };
    switch (verb) {
        case 'list': {
            const buckets = await list();
            console.log(buckets.length === 0 ? `No Buckets in ${project.name}.` : buckets.map((b) => `${b.name.padEnd(32)} ${b.createdAt}`).join('\n'));
            return;
        }
        case 'create': {
            const created = await client.createBucket(project.id, { name: name as string });
            return created.ok
                ? console.log(`Created ${created.value.name} in ${project.name}: S3 endpoint ${s3Endpoint(created.value.name, created.value.access.endpoint)}`)
                : fail(created.error.message);
        }
        case 'show': {
            const { access, createdAt } = await details();
            console.log(
                [
                    `Name:           ${name}`,
                    `S3 endpoint:    ${s3Endpoint(name as string, access.endpoint)}   (virtual-hosted style: https://${new URL(access.endpoint).host})`,
                    `Region:         ${access.region}`,
                    `Access key id:  ${access.accessKeyId}`,
                    `Created:        ${createdAt}`,
                ].join('\n'),
            );
            return;
        }
        case 'show-access-key': {
            const { access } = await details();
            if (access.secretAccessKey === undefined) {
                return fail("this API key may not read the Bucket's key; it needs openupstream:write");
            }
            console.log(`Access key id:      ${access.accessKeyId}\nSecret access key:  ${access.secretAccessKey}`);
            return;
        }
        case 'export-env': {
            const entries = bucketEnv(await details());
            if (!entries.ok) {
                return fail(entries.error);
            }
            const path = resolve(values.file ?? '.env');
            // Only a file that is not there reads as empty: one that cannot be read is not written over.
            const before = await readFile(path, 'utf8').catch((error: unknown) =>
                error instanceof Error && 'code' in error && error.code === 'ENOENT' ? '' : fail(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`),
            );
            // A file holds one Bucket's variables: their names are the same for every Bucket.
            const other = bucketIn(before);
            const written = await writeFile(path, mergeEnv(before, entries.value), { mode: 0o600 }).then(
                () => undefined,
                (error: unknown) => (error instanceof Error ? error.message : String(error)),
            );
            if (written !== undefined) {
                return fail(`cannot write ${path}: ${written}`);
            }
            console.log(`Wrote ${entries.value.map((entry) => entry.name).join(', ')} to ${path}. It holds the Bucket's secret: keep it out of git.`);
            if (other !== undefined && other !== name) {
                console.log(`They replace those of the Bucket ${other}, which the file held: use --file for a file per Bucket.`);
            }
            return;
        }
        case 'delete': {
            const deleted = await client.deleteBucket(project.id, (await named()).id);
            return deleted.ok ? console.log(`Deleted ${name} and every object in it.`) : fail(deleted.error.message);
        }
        default:
            return fail(USAGE);
    }
}

/** `oup domain`: the linked Project's Domains; a custom one is claimed, proven with a DNS record, and deleted (decision 135). */
async function domain(args: string[]): Promise<void> {
    const [verb, ...rest] = args;
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { project: { type: 'string' } } });
    const [typed] = positionals;
    if (verb === undefined || !['list', 'add', 'verify', 'delete'].includes(verb) || (verb !== 'list' && typed === undefined)) {
        return fail(USAGE);
    }
    const { client, project } = await inProject(values.project);
    const listed = await client.listDomains(project.id);
    const domains = listed.ok ? listed.value : fail(listed.error.message);
    if (verb === 'list') {
        console.log(formatDomains(domains).join('\n'));
        return;
    }
    const hostname = hostnameOf(typed as string);
    const records = (claimed: Domain): string => dnsRecords(claimed, ingressOf(domains)).join('\n');
    if (verb === 'add') {
        const problem = hostnameProblem(hostname);
        if (problem !== undefined) {
            return fail(problem);
        }
        const created = await client.createDomain(project.id, { hostname });
        if (!created.ok) {
            return fail(created.error.message);
        }
        console.log(`Added ${hostname} to ${project.name}. Publish these DNS records, then run: oup domain verify ${hostname}\n${records(created.value)}`);
        console.log('The TXT record proves the domain is yours; the CNAME brings its traffic here. Publish the CNAME before the first Route: the certificate is requested then.');
        return;
    }
    const found = domainNamed(domains, hostname, project.name);
    if (!found.ok) {
        return fail(found.error);
    }
    if (verb === 'verify') {
        if (found.value.kind === 'default' || found.value.verification.state === 'verified') {
            console.log(`${hostname} is ${found.value.kind === 'default' ? "the Project's default Domain and needs no proof" : 'verified already'}.`);
            return;
        }
        const verified = await client.verifyDomain(project.id, found.value.id);
        return verified.ok ? console.log(`${hostname} is verified: its Routes are served.`) : fail(`${verified.error.message}\n${records(found.value)}`);
    }
    const deleted = await client.deleteDomain(project.id, found.value.id);
    return deleted.ok ? console.log(`Deleted ${hostname} and its Routes from ${project.name}.`) : fail(deleted.error.message);
}

/** `oup route`: what is served where. A Route is named by its address, `<hostname>/<path>`, or `/<path>` on the default Domain. */
async function route(args: string[]): Promise<void> {
    const [verb, ...rest] = args;
    const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { project: { type: 'string' }, bucket: { type: 'string' }, service: { type: 'string' }, spa: { type: 'boolean' } },
    });
    const [address] = positionals;
    const target = values.bucket !== undefined || values.service !== undefined || values.spa !== undefined;
    if (verb === undefined || !['list', 'add', 'delete'].includes(verb) || (verb !== 'list' && address === undefined) || (verb !== 'add' && target)) {
        return fail(USAGE);
    }
    const { client, project } = await inProject(values.project);
    const listed = await client.listDomains(project.id);
    const domains = listed.ok ? listed.value : fail(listed.error.message);
    const routesOf = async (domainId: string): Promise<Route[]> => {
        const routes = await client.listRoutes(project.id, domainId);
        return routes.ok ? routes.value : fail(routes.error.message);
    };
    const buckets = async (): Promise<Bucket[]> => {
        const all = await client.listBuckets(project.id);
        return all.ok ? all.value : fail(all.error.message);
    };
    const services = async (): Promise<ServiceDetails[]> => {
        const all = await client.listServices(project.id);
        return all.ok ? all.value : fail(all.error.message);
    };
    if (verb === 'list') {
        const [routes, allBuckets, allServices] = await Promise.all([Promise.all(domains.map((each) => routesOf(each.id))), buckets(), services()]);
        const lines = formatRoutes(domains, Object.fromEntries(domains.map((each, index) => [each.id, routes[index] ?? []])), allBuckets, allServices);
        console.log(lines.length === 0 ? `No Routes in ${project.name}: every path answers 404.` : lines.join('\n'));
        return;
    }
    const named = parseAddress(address as string, domains, project.name);
    if (!named.ok) {
        return fail(named.error);
    }
    const { domain: at, pathPrefix } = named.value;
    const where = `${at.hostname}${pathPrefix}`;
    if (verb === 'add') {
        // Only the list the Route's target is in.
        const input = routeInput(pathPrefix, values, values.bucket === undefined ? [] : await buckets(), values.service === undefined ? [] : await services(), project.name);
        if (!input.ok) {
            return fail(input.error);
        }
        const created = await client.createRoute(project.id, at.id, input.value);
        if (!created.ok) {
            return fail(routeRefusal(created.error.message, values));
        }
        const pending = at.kind === 'custom' && at.verification.state === 'pending';
        console.log(pending ? `Added the Route ${where}. It is served once the Domain is verified: oup domain verify ${at.hostname}` : `Added the Route: https://${where} is served within a minute.`);
        return;
    }
    const existing = (await routesOf(at.id)).find((candidate) => candidate.pathPrefix === pathPrefix);
    if (existing === undefined) {
        return fail(`no Route ${where} in ${project.name}; oup route list shows them`);
    }
    const deleted = await client.deleteRoute(project.id, at.id, existing.id);
    return deleted.ok ? console.log(`Deleted the Route ${where}; what it went to stays.`) : fail(deleted.error.message);
}

/** `oup usage`: what the linked Project's Resources use now of what they were given (decision 124); not what is billed. */
/** `oup member`: the Account's Members, their roles, removing one, leaving. */
async function member(args: string[]): Promise<void> {
    const [verb, ...rest] = args;
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { account: { type: 'string' } } });
    const [email, role, ...extra] = positionals;
    const arity = { list: 0, leave: 0, remove: 1, role: 2 }[verb ?? ''];
    if (arity === undefined || positionals.length !== arity || extra.length > 0) {
        return fail(USAGE);
    }
    const client = await apiClient();
    const account = accountFor(await listAccounts(client), values.account);
    if (!account.ok) {
        return fail(account.error);
    }
    const refusal = (error: { status: number; message: string }) =>
        fail(error.status === 409 ? `${error.message}\n  ${LAST_OWNER_HINT}` : error.message);
    if (verb === 'leave') {
        const left = await client.removeMember(account.value.id, 'me');
        return left.ok ? console.log(`You left the Account ${account.value.name}.`) : refusal(left.error);
    }
    const members = await client.listMembers(account.value.id);
    if (!members.ok) {
        return fail(members.error.message);
    }
    if (verb === 'list') {
        return console.log(formatMembers(members.value).join('\n'));
    }
    const target = memberByEmail(members.value, email ?? '');
    if (!target.ok) {
        return fail(target.error);
    }
    if (verb === 'remove') {
        const removed = await client.removeMember(account.value.id, target.value.id);
        return removed.ok
            ? console.log(`Removed ${target.value.email} from ${account.value.name}; their Postgres roles in its Databases are dropped.`)
            : refusal(removed.error);
    }
    const parsed = parseRole(role);
    if (!parsed.ok) {
        return fail(parsed.error);
    }
    const changed = await client.updateMember(account.value.id, target.value.id, { role: parsed.value });
    return changed.ok ? console.log(`${changed.value.email} is now ${changed.value.role} of ${account.value.name}.`) : refusal(changed.error);
}

async function usage(args: string[]): Promise<void> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { project: { type: 'string' }, instances: { type: 'boolean' }, json: { type: 'boolean' } },
    });
    if (positionals.length > 0) {
        return fail(USAGE);
    }
    const { client, project } = await inProject(values.project);
    const read = await client.getUsage(project.id);
    if (!read.ok) {
        return fail(read.error.message);
    }
    console.log(values.json === true ? JSON.stringify(read.value, null, 2) : formatUsage(read.value, project.name, { instances: values.instances ?? false }).join('\n'));
}

async function siteDeploy(args: string[]): Promise<void> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { bucket: { type: 'string' }, keep: { type: 'boolean' }, force: { type: 'boolean' } },
    });
    const [dir] = positionals;
    if (dir === undefined || values.bucket === undefined) {
        return fail(USAGE);
    }
    const access = await apiAccess(credentialsPath());
    if (!access.ok) {
        return fail(access.error);
    }
    const client = new OpenUpstreamClient({ baseUrl: access.value.apiUrl, token: access.value.token });
    const projects = await client.listProjects();
    if (!projects.ok) {
        return fail(projects.error.message);
    }
    // Bucket names are unique across all Projects.
    const listed = await Promise.all(projects.value.map((project) => client.listBuckets(project.id)));
    const found = listed.flatMap((buckets) => (buckets.ok ? buckets.value : [])).find((bucket) => bucket.name === values.bucket);
    if (found === undefined) {
        const failed = listed.find((buckets) => !buckets.ok);
        return fail(failed !== undefined && !failed.ok ? failed.error.message : `no Bucket ${values.bucket} in your Projects`);
    }
    const details = await client.getBucket(found.projectId, found.id);
    if (!details.ok) {
        return fail(details.error.message);
    }
    const { endpoint, region, accessKeyId, secretAccessKey } = details.value.access;
    if (secretAccessKey === undefined) {
        return fail('this API key may not read the Bucket\'s key; it needs openupstream:write');
    }
    // The Bucket's endpoint is its own hostname, <bucket>.s3.<domain>; the client puts the name in front itself.
    const host = new URL(endpoint).host.replace(`${found.name}.`, '');
    const s3 = new S3Client({ endpoint: `https://${host}`, region, credentials: { accessKeyId, secretAccessKey }, forcePathStyle: false });
    const plan = await deploy(s3, found.name, dir, { keep: values.keep ?? false, force: values.force ?? false, log: (line) => console.log(line) });
    console.log(`${plan.uploads.length} uploaded, ${plan.unchanged} unchanged, ${plan.deletions.length} deleted`);
}

const [command, ...rest] = process.argv.slice(2);
const run = async (): Promise<void> => {
    switch (command) {
        case 'login':
            return login(rest);
        case 'logout':
            return logout();
        case 'project':
            return project(rest);
        case 'link':
            return link(rest);
        case 'member':
            return member(rest);
        case 'pg':
            return pg(rest);
        case 'service':
            return service(rest);
        case 'job':
            return job(rest);
        case 'secret':
            return secret(rest);
        case 'bucket':
            return bucket(rest);
        case 'domain':
            return domain(rest);
        case 'route':
            return route(rest);
        case 'usage':
            return usage(rest);
        case 'site':
            return rest[0] === 'deploy' ? siteDeploy(rest.slice(1)) : fail(USAGE);
        case 'version':
        case '--version':
        case '-v':
            console.log(`oup ${CLI_VERSION} (sdk ${SDK_VERSION})`);
            return;
        case undefined:
        case 'help':
        case '--help':
            console.log(USAGE);
            return;
        default:
            return fail(USAGE);
    }
};
await run().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
