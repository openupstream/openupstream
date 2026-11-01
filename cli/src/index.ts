#!/usr/bin/env node
/**
 * oup, the openupstream CLI.
 *
 *   oup login [--api <url>] [--no-browser]   sign in through the browser (device grant)
 *   oup logout
 *   oup link <project>                       this directory's Project (.openupstream.json)
 *   oup service list | show <name> | delete <name>
 *   oup service deploy <name> --image <ref> [--port …] …
 *   oup secret list | set <NAME> | delete <NAME>   a value is read from stdin
 *   oup site deploy <dir> --bucket <name> [--keep] [--force]
 *   oup version
 *
 * Service and secret commands act on the linked Project; `--project` or
 * `OUP_PROJECT` names another.
 *
 * Planned (ARCHITECTURE.md build order): oup pg, oup bucket, oup run, oup
 * cron, oup routes, oup logs, oup usage.
 *
 * `OUP_API_KEY` (a madAuth API key) replaces `oup login`, e.g. in CI, with
 * `OUP_API_URL` for another API than https://api.openupstream.com.
 */
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { S3Client } from '@aws-sdk/client-s3';
import { COMPUTE_SITES, DEFAULT_API_URL, OpenUpstreamClient, type Project, SDK_VERSION, type Site, cliLogin } from '@openupstream/sdk';
import { credentialsPath, readCredentials, removeCredentials, writeCredentials } from './credentials.js';
import { deploy } from './deploy.js';
import { discover, emailOf, startDeviceSignIn, waitForApproval } from './oidc.js';
import { projectFor, resolveProject, writeLink } from './project.js';
import { type DesiredService, formatServices, planServiceDeploy, waitUntilRunning } from './services.js';
import { apiAccess } from './session.js';
import { readSecretValue } from './stdin.js';

const USAGE = `usage:
  oup login [--api <url>] [--no-browser]
  oup logout
  oup link <project>
  oup service list
  oup service show <name>
  oup service deploy <name> --image <ref> [--port <n>] [--replicas <n>] [--memory <MB>] [--cpu <millicores>]
                     [--site hetzner-fsn1|ovh-lim] [--registry-user <user> --registry-password-stdin] [--no-wait]
  oup service delete <name>
  oup secret list
  oup secret set <NAME>        (the value from stdin)
  oup secret delete <NAME>
  oup site deploy <dir> --bucket <name> [--keep] [--force]
  oup version

Service and secret commands take --project <name|id>; without it, the
Project linked to this directory (oup link) or OUP_PROJECT.`;

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

async function service(args: string[]): Promise<void> {
    const [verb, ...rest] = args;
    const { values, positionals } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: {
            project: { type: 'string' },
            image: { type: 'string' },
            port: { type: 'string' },
            replicas: { type: 'string' },
            memory: { type: 'string' },
            cpu: { type: 'string' },
            site: { type: 'string' },
            'registry-user': { type: 'string' },
            'registry-password-stdin': { type: 'boolean' },
            'no-wait': { type: 'boolean' },
        },
    });
    const [name] = positionals;
    if (verb !== 'list' && name === undefined) {
        return fail(USAGE);
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
        default:
            return fail(USAGE);
    }
}

async function serviceDeploy(
    client: OpenUpstreamClient,
    project: Project,
    existing: Parameters<typeof planServiceDeploy>[0],
    flags: { name: string; image?: string; port?: string; replicas?: string; memory?: string; cpu?: string; site?: string; 'registry-user'?: string; 'registry-password-stdin'?: boolean; 'no-wait'?: boolean },
): Promise<void> {
    if (flags.image === undefined) {
        return fail('oup service deploy needs --image');
    }
    if (flags.site !== undefined && !isSite(flags.site)) {
        return fail(`--site is one of ${COMPUTE_SITES.join(', ')}`);
    }
    if ((flags['registry-user'] === undefined) !== (flags['registry-password-stdin'] !== true)) {
        return fail('--registry-user and --registry-password-stdin go together');
    }
    const password = flags['registry-user'] === undefined ? undefined : await readSecretValue('Registry password: ');
    if (flags['registry-user'] !== undefined && (password === undefined || password === '')) {
        return fail('no registry password on stdin');
    }
    const port = count('port', flags.port);
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
        ...(flags['registry-user'] === undefined || password === undefined ? {} : { registryAuth: { username: flags['registry-user'], password } }),
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
        case 'link':
            return link(rest);
        case 'service':
            return service(rest);
        case 'secret':
            return secret(rest);
        case 'site':
            return rest[0] === 'deploy' ? siteDeploy(rest.slice(1)) : fail(USAGE);
        case 'version':
        case '--version':
        case '-v':
            console.log(`oup ${SDK_VERSION}`);
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
