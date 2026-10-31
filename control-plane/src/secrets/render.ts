/**
 * Renders a Project's Secrets into the Kubernetes Secret its Services and
 * jobs read with `envFrom` (ARCHITECTURE.md, "Secrets"; decision 91). The
 * control plane does this itself, since it alone holds the key-encryption
 * key: no decrypted value ever crosses the internal API.
 *
 * `syncProjectSecrets` writes one Project's Secret; the API calls it after
 * every change, so a new value reaches the cluster at once. `secretsPass`
 * writes every Project's, every interval, so a change whose write failed,
 * or that came before the Project had a namespace, arrives within one pass.
 */
import { PROJECT_SECRETS, projectNamespace } from '@openupstream/sdk';
import type pg from 'pg';
import type { ControlPlaneKube, SecretManifest } from '../kube.js';
import { type Result, err, ok } from '../result.js';
import type { KeyEncryptionKey } from './envelope.js';
import { readSecretValues } from './store.js';

export interface SecretsDeps {
    readonly pool: pg.Pool;
    readonly kube: ControlPlaneKube;
    readonly kek: KeyEncryptionKey;
    readonly log: (entry: Record<string, unknown>) => void;
}

export const projectSecretManifest = (projectId: string, values: ReadonlyMap<string, string>): SecretManifest => ({
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
        name: PROJECT_SECRETS,
        namespace: projectNamespace(projectId),
        labels: { 'openupstream.io/project-id': projectId, 'app.kubernetes.io/managed-by': 'openupstream-control-plane' },
    },
    data: Object.fromEntries([...values].map(([name, value]) => [name, Buffer.from(value, 'utf8').toString('base64')])),
});

/**
 * Writes the Project's Secret with every value it has now, an empty one
 * when it has none left. `no-namespace` until an operator has created the
 * Project's namespace.
 */
export async function syncProjectSecrets(
    deps: Pick<SecretsDeps, 'pool' | 'kube' | 'kek'>,
    projectId: string,
): Promise<Result<'applied' | 'no-namespace', string>> {
    const values = await readSecretValues(deps.pool, deps.kek, projectId);
    if (!values.ok) {
        return err(`cannot read the Secrets: ${values.error.kind}`);
    }
    return deps.kube.applySecret(projectSecretManifest(projectId, values.value));
}

/**
 * One pass over every live Project that has ever had a Secret (it has a
 * data key). A Project whose write fails is logged; the others go on.
 */
export async function secretsPass(deps: SecretsDeps): Promise<void> {
    const projects = await deps.pool.query<{ id: string }>(
        `select p.id from projects p join project_data_keys k on k.project_id = p.id
         where p.deleted_at is null order by p.id`,
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
