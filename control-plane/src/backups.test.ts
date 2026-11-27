import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusterKey } from './backups.js';

test('a Database\'s folder is deleted inside the cluster\'s folder only', () => {
    assert.deepEqual(clusterKey('20261127-a1b2c3', 'project-1/db-2/'), { ok: true, value: '20261127-a1b2c3/project-1/db-2/' });
});

test('clusterKey refuses prefixes that could match more than one folder', () => {
    for (const prefix of ['project-1/db-2', '/', '/project-1/db-2/', '']) {
        assert.equal(clusterKey('c1', prefix).ok, false, prefix);
    }
    for (const cluster of ['', 'a/b', '..', 'Upper']) {
        assert.equal(clusterKey(cluster, 'project-1/db-2/').ok, false, cluster);
    }
});
