import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account, Project } from '@openupstream/sdk';
import { LINK_FILE, accountFor, findLink, formatProjects, projectFor, resolveProject, writeLink } from './project.js';

const project = (id: string, name: string, accountId = 'a'): Project => ({ id, accountId, name, createdAt: '2026-11-01T00:00:00Z' });
const shop = project('11111111-1111-4111-8111-111111111111', 'shop');
const blog = project('22222222-2222-4222-8222-222222222222', 'blog');
const otherShop = project('33333333-3333-4333-8333-333333333333', 'shop', 'b');

test('a Project by id, or by a name only one of the Accounts has', () => {
    assert.deepEqual(resolveProject([shop, blog], 'shop'), { ok: true, value: shop });
    assert.deepEqual(resolveProject([shop, blog, otherShop], otherShop.id), { ok: true, value: otherShop });
    const ambiguous = resolveProject([shop, blog, otherShop], 'shop');
    assert.ok(!ambiguous.ok && ambiguous.error.includes(otherShop.id));
    const missing = resolveProject([shop], 'nope');
    assert.ok(!missing.ok && missing.error.includes('you have shop'));
});

test('the link is found in the directory or any above it; --project wins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oup-link-'));
    const deep = join(root, 'app', 'src');
    await mkdir(deep, { recursive: true });
    assert.deepEqual(await findLink(deep), { ok: true, value: undefined });
    const path = await writeLink(root, shop);
    assert.equal(path, join(root, LINK_FILE));
    assert.deepEqual(await findLink(deep), { ok: true, value: { path, link: { projectId: shop.id, project: 'shop' } } });
    assert.deepEqual(await projectFor([shop, blog], undefined, deep), { ok: true, value: shop });
    assert.deepEqual(await projectFor([shop, blog], 'blog', deep), { ok: true, value: blog });
});

test('a linked Project that is gone, a broken link file, or none at all is an error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oup-link-'));
    await writeLink(root, shop);
    const gone = await projectFor([blog], undefined, root);
    assert.ok(!gone.ok && gone.error.includes('not among yours'));
    await writeFile(join(root, LINK_FILE), '{"project":');
    assert.equal((await projectFor([shop], undefined, root)).ok, false);
});

const account = (id: string, name: string): Account => ({ id, name, createdAt: '2026-11-01T00:00:00Z', holds: [] });
const acme = account('a', 'acme');
const david = account('b', 'david');

test('a Project is created in the only Account, or in the one --account names', () => {
    assert.deepEqual(accountFor([acme], undefined), { ok: true, value: acme });
    assert.deepEqual(accountFor([acme, david], 'david'), { ok: true, value: david });
    assert.deepEqual(accountFor([acme, david], 'a'), { ok: true, value: acme });
    const several = accountFor([acme, david], undefined);
    assert.ok(!several.ok && several.error.includes('pass --account') && several.error.includes('acme, david'));
    const none = accountFor([], undefined);
    assert.ok(!none.ok && none.error.includes('not a Member') && none.error.includes('POST /v1/accounts'));
    const missing = accountFor([acme], 'nope');
    assert.ok(!missing.ok && missing.error.includes('you have acme'));
    const twins = accountFor([acme, account('c', 'acme')], 'acme');
    assert.ok(!twins.ok && twins.error.includes('use its id'));
});

test('Projects are listed by name, with their Account and the one linked here', () => {
    const lines = formatProjects([shop, blog, otherShop], [acme, david], shop.id);
    assert.equal(lines.length, 3);
    assert.match(lines[0] ?? '', /^blog\s+acme\s+22222222-/);
    assert.match(lines.find((line) => line.includes(shop.id)) ?? '', /^shop\s+acme\s+.*\(linked here\)$/);
    assert.match(lines.find((line) => line.includes(otherShop.id)) ?? '', /^shop\s+david\s+33333333-[^(]*$/);
});

