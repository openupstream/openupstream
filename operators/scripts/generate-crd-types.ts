/**
 * Generates TypeScript types for the CRDs vendored in `crds/` into
 * `src/generated/` (gitignored). Each CRD's stored version's OpenAPI schema
 * becomes one exported interface named after its kind.
 *
 * Run with `npm run generate -w operators`; build, typecheck and test run it
 * first.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    await writeFile(join(outDir, `${module}.ts`), source);
    return { kind, module };
};

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
const files = (await readdir(crdDir)).filter((f) => f.endsWith('.yaml')).sort();
const generated = await Promise.all(files.map(generate));
const index = generated.map(({ kind, module }) => `export type { ${kind} } from './${module}.js';`).join('\n');
await writeFile(join(outDir, 'index.ts'), `${index}\n`);
