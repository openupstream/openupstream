/**
 * Generates TypeScript types for the CRDs vendored in `crds/` into
 * `src/generated/` (gitignored). Each CRD's stored version's OpenAPI schema
 * becomes one exported interface named after its kind.
 *
 * Run with `npm run generate -w operators`; build, typecheck and test run it
 * first.
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { compile, type JSONSchema } from 'json-schema-to-typescript';
import { parse } from 'yaml';

interface CrdVersion {
    name: string;
    storage: boolean;
    schema: { openAPIV3Schema: JSONSchema };
}

interface Crd {
    kind: 'CustomResourceDefinition';
    spec: { group: string; names: { kind: string }; versions: CrdVersion[] };
}

const root = join(import.meta.dirname, '..');
const crdDir = join(root, 'crds');
const outDir = join(root, 'src', 'generated');

/**
 * Replaces a file atomically, so a concurrent build or test that reads the
 * generated types never sees a missing or half-written file.
 */
const writeAtomically = async (path: string, content: string): Promise<void> => {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, content);
    await rename(temporary, path);
};

const banner = (file: string, crd: Crd, version: string): string =>
    `/* Generated from crds/${file} (${crd.spec.group}/${version}) by scripts/generate-crd-types.ts. Do not edit. */`;

const generate = async (file: string): Promise<{ kind: string; module: string }> => {
    const crd = parse(await readFile(join(crdDir, file), 'utf8')) as Crd;
    const stored = crd.spec.versions.find((v) => v.storage);
    if (stored === undefined) throw new Error(`${file}: no storage version`);
    const kind = crd.spec.names.kind;
    const source = await compile(stored.schema.openAPIV3Schema, kind, {
        bannerComment: banner(file, crd, stored.name),
        // Kubernetes schemas list every allowed field; unknown ones are typos.
        additionalProperties: false,
        format: false,
        strictIndexSignatures: true,
    });
    const module = basename(file, '.yaml');
    await writeAtomically(join(outDir, `${module}.ts`), source);
    return { kind, module };
};

await mkdir(outDir, { recursive: true });
const files = (await readdir(crdDir)).filter((f) => f.endsWith('.yaml')).sort();
const generated = await Promise.all(files.map(generate));
const index = generated.map(({ kind, module }) => `export type { ${kind} } from './${module}.js';`).join('\n');
await writeAtomically(join(outDir, 'index.ts'), `${index}\n`);
// Drop the types of CRDs that were removed from crds/.
const current = new Set(['index.ts', ...generated.map(({ module }) => `${module}.ts`)]);
const stale = (await readdir(outDir)).filter((f) => f.endsWith('.ts') && !current.has(f));
await Promise.all(stale.map((f) => rm(join(outDir, f))));
