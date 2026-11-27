import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSiteOf, siteChoices, siteLabel, siteName } from './sites';

const sites = [
    { id: 'home-a', description: 'Home VM A', default: false },
    { id: 'home-b', description: null, default: true },
];

test('a Site shows its description, then its id; the id alone without one', () => {
    assert.equal(siteLabel(sites[0]!), 'Home VM A · home-a');
    assert.equal(siteLabel(sites[1]!), 'home-b');
    assert.equal(siteName('home-a', sites), 'Home VM A · home-a');
    assert.equal(siteName('gone', sites), 'gone');
});

test('the default Site is the marked one, else the first; none without a list', () => {
    assert.equal(defaultSiteOf(sites), 'home-b');
    assert.equal(defaultSiteOf([{ ...sites[0]!, default: false }]), 'home-a');
    assert.equal(defaultSiteOf([]), '');
});

test('a select offers every compute Site, and keeps a Site the list no longer has', () => {
    assert.deepEqual(siteChoices(sites, 'home-a').map((choice) => choice.id), ['home-a', 'home-b']);
    assert.deepEqual(siteChoices(sites, ''), siteChoices(sites, 'home-b'));
    assert.deepEqual(siteChoices(sites, 'gone').at(-1), { id: 'gone', label: 'gone' });
});
