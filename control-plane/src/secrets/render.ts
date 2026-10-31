/**
 * Renders a Project's Secrets into the Kubernetes Secret its Services and
 * jobs read with `envFrom` (ARCHITECTURE.md, "Secrets"; decision 91), and
 * its Services' registry credentials into the one they pull with. The
 * control plane does this itself, since it alone holds the key-encryption
 * key: no decrypted value ever crosses the internal API.
 *
 * `syncProjectSecrets` writes one Project's Secret; the API calls it after
 * every change, so a new value reaches the cluster at once. `secretsPass`
 * writes every Project's, every interval, so a change whose write failed,
 * or that came before the Project had a namespace, arrives within one pass.
 */
import { PROJECT_REGISTRY_AUTH, PROJECT_SECRETS, type RegistryAuth, projectNamespace } from '@openupstream/sdk';
import type pg from 'pg';
import type { ControlPlaneKube, SecretManifest } from '../kube.js';
import { type Result, err, ok } from '../result.js';
import { credentialKey, parseImageReference } from '../registry.js';
import { registryAuthName } from '../services/store.js';
import type { KeyEncryptionKey } from './envelope.js';
import { openProjectValue, readSecretValues } from './store.js';

export interface SecretsDeps {
    readonly pool: pg.Pool;
    readonly kube: ControlPlaneKube;
    readonly kek: KeyEncryptionKey;
    readonly log: (entry: Record<string, unknown>) => void;
}

const base64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');

const secretManifest = (projectId: string, name: string, type: string, data: Record<string, string>): SecretManifest => ({
    apiVersion: 'v1',
    kind: 'Secret',
    type,
    metadata: {
        name,
        namespace: projectNamespace(projectId),
        labels: { 'openupstream.io/project-id': projectId, 'app.kubernetes.io/managed-by': 'openupstream-control-plane' },
    },
    data,
});

export const projectSecretManifest = (projectId: string, values: ReadonlyMap<string, string>): SecretManifest =>
    secretManifest(projectId, PROJECT_SECRETS, 'Opaque', Object.fromEntries([...values].map(([name, value]) => [name, base64(value)])));

/**
 * The Project's registry credentials as kubelet reads them: one entry per
 * Service's repository (`ghcr.io/acme/api`), which kubelet matches against
 * the image it pulls. Empty when no Service has any.
 */
export const registryAuthManifest = (projectId: string, credentials: ReadonlyMap<string, RegistryAuth>): SecretManifest =>
    secretManifest(projectId, PROJECT_REGISTRY_AUTH, 'kubernetes.io/dockerconfigjson', {
        '.dockerconfigjson': base64(
            JSON.stringify({
                auths: Object.fromEntries(
                    [...credentials].map(([key, { username, password }]) => [
                        key,
                        { username, password, auth: base64(`${username}:${password}`) },
                    ]),
                ),
            }),
        ),
    });

/** Every Service's registry credentials, opened, by the key kubelet matches. */
async function registryCredentials(
    deps: Pick<SecretsDeps, 'pool' | 'kek'>,
    projectId: string,
): Promise<Result<ReadonlyMap<string, RegistryAuth>, string>> {
    const { rows } = await deps.pool.query<{ id: string; image: string; registry_auth: Buffer }>(
        'select id, image, registry_auth from services where project_id = $1 and registry_auth is not null order by created_at, id',
        [projectId],
    );
    const credentials = new Map<string, RegistryAuth>();
    for (const row of rows) {
        const image = parseImageReference(row.image);
        const opened = await openProjectValue(deps.pool, deps.kek, projectId, registryAuthName(row.id), row.registry_auth);
        if (!opened.ok) {
            return err(`cannot open the registry credentials of Service ${row.id}: ${opened.error.kind}`);
        }
        if (image.ok) {
            credentials.set(credentialKey(image.value), JSON.parse(opened.value) as RegistryAuth);
        }
    }
    return ok(credentials);
}

/**
 * Writes the Project's two Secrets with what it has now, empty ones when it
 * has nothing left. `no-namespace` until an operator has created the
 * Project's namespace.
 */
export async function syncProjectSecrets(
    deps: Pick<SecretsDeps, 'pool' | 'kube' | 'kek'>,
    projectId: string,
): Promise<Result<'applied' | 'no-namespace', string>> {
    // Read before the values: a change in between leaves an older version recorded, so the next pass writes again.
    const version = await secretsVersionOf(deps.pool, projectId);
    const values = await readSecretValues(deps.pool, deps.kek, projectId);
    if (!values.ok) {
        return err(`cannot read the Secrets: ${values.error.kind}`);
    }
    const credentials = await registryCredentials(deps, projectId);
    if (!credentials.ok) {
        return credentials;
    }
    const secrets = await deps.kube.applySecret(projectSecretManifest(projectId, values.value));
    if (!secrets.ok || secrets.value === 'no-namespace') {
        return secrets;
    }
    const registry = await deps.kube.applySecret(registryAuthManifest(projectId, credentials.value));
    if (!registry.ok || registry.value === 'no-namespace') {
        return registry;
    }
    // Only now may the Services roll: their pods will read these values.
    await deps.pool.query('update projects set secrets_version = $2 where id = $1 and secrets_version is distinct from $2', [projectId, version]);
    return registry;
}

/** Changes whenever a Secret is created, changed or deleted: names and update times, no values. */
const secretsVersionOf = async (pool: pg.Pool, projectId: string): Promise<string> => {
    const { rows } = await pool.query<{ version: string }>(
        `select md5(coalesce(string_agg(name || '@' || updated_at::text, ',' order by name), '')) as version
         from secrets where project_id = $1`,
        [projectId],
    );
    return rows[0]?.version ?? '';
};

/**
 * One pass over every live Project that has ever had a Secret or registry
 * credentials (it has a data key), or has a Service: its pods wait for
 * `project-secrets` to exist, so they never start without the values they
 * are meant to have, and a Project without Secrets gets an empty one. A
 * Project whose write fails is logged; the others go on.
 */
export async function secretsPass(deps: SecretsDeps): Promise<void> {
    const projects = await deps.pool.query<{ id: string }>(
        `select p.id from projects p
         where p.deleted_at is null
           and (exists (select 1 from project_data_keys k where k.project_id = p.id)
                or exists (select 1 from services s where s.project_id = p.id))
         order by p.id`,
    );
    const outcomes = await Promise.all(
        projects.rows.map(async ({ id }) => ({ projectId: id, result: await syncProjectSecrets(deps, id) })),
    );
    const failed = outcomes.flatMap(({ projectId, result }) => (result.ok ? [] : [{ projectId, error: result.error }]));
    for (const failure of failed) {
        deps.log({ msg: 'cannot write the Secrets of a Project', ...failure });
    }
    deps.log({
        msg: 'secrets pass done',
        projects: outcomes.length,
        waitingForNamespace: outcomes.filter(({ result }) => result.ok && result.value === 'no-namespace').length,
        failed: failed.length,
    });
}
