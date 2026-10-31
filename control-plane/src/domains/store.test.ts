import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultHostname, isReserved, randomSuffix } from './store.js';

test('a default hostname is <project>-<suffix> under the customer domain', () => {
    assert.equal(defaultHostname('shop', 'openupstream.app', 'a1b2c3d4'), 'shop-a1b2c3d4.openupstream.app');
    assert.match(randomSuffix(), /^[a-z0-9]{8}$/);
    assert.notEqual(randomSuffix(), randomSuffix());
});

test('a long Project name is cut so the label stays within 63 characters, without a hyphen before the suffix', () => {
    const long = defaultHostname(`${'a'.repeat(53)}-bcdefghij`, 'openupstream.app', 'a1b2c3d4');
    const label = long.split('.')[0] ?? '';
    assert.equal(label.length, 62);
    assert.equal(label, `${'a'.repeat(53)}-a1b2c3d4`);
    assert.equal(defaultHostname('x'.repeat(63), 'openupstream.app', 'a1b2c3d4').split('.')[0]?.length, 63);
});

test('the platform\'s domains and everything below them are reserved, look-alikes are not', () => {
    const reserved = ['openupstream.app', 'openupstream.com'];
    for (const hostname of ['openupstream.app', 'shop-a1b2c3d4.openupstream.app', 'x.s3.openupstream.app', 'api.openupstream.com']) {
        assert.equal(isReserved(hostname, reserved), true, hostname);
    }
    for (const hostname of ['myopenupstream.app', 'openupstream.app.example', 'shop.example']) {
        assert.equal(isReserved(hostname, reserved), false, hostname);
    }
});
