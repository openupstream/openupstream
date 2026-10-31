#!/usr/bin/env node
/**
 * oup, the openupstream CLI.
 *
 *   oup login [--api <url>] [--no-browser]   sign in through the browser (device grant)
 *   oup logout
 *   oup site deploy <dir> --bucket <name> [--keep]
 *   oup version
 *
 * Planned (ARCHITECTURE.md build order): oup pg, oup bucket, oup deploy
 * <image>, oup run, oup cron, oup routes, oup secrets, oup usage.
 *
 * `OUP_API_KEY` (a madAuth API key) replaces `oup login`, e.g. in CI, with
 * `OUP_API_URL` for another API than https://api.openupstream.com.
 */
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { S3Client } from '@aws-sdk/client-s3';
import { DEFAULT_API_URL, OpenUpstreamClient, SDK_VERSION, cliLogin } from '@openupstream/sdk';
import { credentialsPath, readCredentials, removeCredentials, writeCredentials } from './credentials.js';
import { deploy } from './deploy.js';
import { discover, emailOf, startDeviceSignIn, waitForApproval } from './oidc.js';
import { apiAccess } from './session.js';

const USAGE = `usage:
  oup login [--api <url>] [--no-browser]
  oup logout
  oup site deploy <dir> --bucket <name> [--keep]
  oup version`;

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

async function siteDeploy(args: string[]): Promise<void> {
    const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { bucket: { type: 'string' }, keep: { type: 'boolean' } },
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
    const found = (
        await Promise.all(
            projects.value.map(async (project) => {
                const buckets = await client.listBuckets(project.id);
                return buckets.ok ? buckets.value.filter((bucket) => bucket.name === values.bucket) : [];
            }),
        )
    ).flat()[0];
    if (found === undefined) {
        return fail(`no Bucket ${values.bucket} in your Projects`);
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
    const plan = await deploy(s3, found.name, dir, { keep: values.keep ?? false, log: (line) => console.log(line) });
    console.log(`${plan.uploads.length} uploaded, ${plan.unchanged} unchanged, ${plan.deletions.length} deleted`);
}

const [command, ...rest] = process.argv.slice(2);
const run = async (): Promise<void> => {
    switch (command) {
        case 'login':
            return login(rest);
        case 'logout':
            return logout();
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
