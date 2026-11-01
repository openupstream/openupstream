import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '@openupstream/sdk';
import { LINK_FILE, findLink, projectFor, resolveProject, writeLink } from './project.js';

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
