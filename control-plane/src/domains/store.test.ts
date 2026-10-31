import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultHostname, randomSuffix } from './store.js';

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
