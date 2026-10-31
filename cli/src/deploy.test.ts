import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMMUTABLE, NO_CACHE, SHORT, cacheControlFor, contentTypeFor, listLocal, planDeploy } from './deploy.js';

test('cache headers: hashed names for a year, index.html never cached, the rest five minutes', () => {
    for (const key of ['assets/index-BXk3a9Zp.js', 'static/js/main.3f2a9c1b.js', 'chunk-4f1e2d3c5b6a.css', 'assets/logo.a1b2c3d4e5.svg']) {
        assert.equal(cacheControlFor(key), IMMUTABLE, key);
    }
    for (const key of ['index.html', 'docs/index.html']) {
        assert.equal(cacheControlFor(key), NO_CACHE, key);
    }
    for (const key of ['favicon.ico', 'jquery-migration.js', 'docs/guide.html', 'robots.txt', 'assets/abcdefgh.js']) {
        assert.equal(cacheControlFor(key), SHORT, key);
    }
});

test('content types by extension', () => {
    assert.equal(contentTypeFor('index.html'), 'text/html; charset=utf-8');
    assert.equal(contentTypeFor('a/app.MJS'), 'text/javascript; charset=utf-8');
    assert.equal(contentTypeFor('font.woff2'), 'font/woff2');
    assert.equal(contentTypeFor('LICENSE'), 'application/octet-stream');
});

test('only changed files are uploaded, the index files last; stale objects are deleted unless kept', () => {
    const local = [
        { key: 'index.html', path: '', md5: 'i2' },
        { key: 'assets/app-1a2b3c4d.js', path: '', md5: 'a2' },
        { key: 'logo.svg', path: '', md5: 'l1' },
    ];
    const remote = [
        { key: 'index.html', etag: '"i1"' },
        { key: 'assets/app-0a0b0c0d.js', etag: '"a1"' },
        { key: 'logo.svg', etag: '"l1"' },
    ];
    const plan = planDeploy(local, remote, false);
    assert.deepEqual(plan.uploads.map((file) => file.key), ['assets/app-1a2b3c4d.js', 'index.html']);
    assert.equal(plan.unchanged, 1);
    assert.deepEqual(plan.deletions, ['assets/app-0a0b0c0d.js']);
    assert.deepEqual(planDeploy(local, remote, true).deletions, []);
});

test('the directory is read with / keys, without dotfiles but with .well-known', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oup-site-'));
    await mkdir(join(dir, 'assets'));
    await mkdir(join(dir, '.git'));
    await mkdir(join(dir, '.well-known'));
    await writeFile(join(dir, 'index.html'), 'hi');
    await writeFile(join(dir, 'assets', 'app.js'), '');
    await writeFile(join(dir, '.DS_Store'), '');
    await writeFile(join(dir, '.git', 'HEAD'), '');
    await writeFile(join(dir, '.well-known', 'security.txt'), '');
    const files = await listLocal(dir);
    assert.deepEqual(files.map((file) => file.key).sort(), ['.well-known/security.txt', 'assets/app.js', 'index.html']);
    assert.equal(files.find((file) => file.key === 'index.html')?.md5, '49f68a5c8493ec2c0bf489821c21fc3b');
});
