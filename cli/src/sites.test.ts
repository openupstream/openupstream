import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSites } from './sites.js';

test('each Site on a line: its id, whether it is the default, and where it is', () => {
    assert.deepEqual(
        formatSites([
            { id: 'hetzner-fsn1', description: 'Falkenstein (Hetzner)', default: true },
            { id: 'ovh-lim', description: null, default: false },
        ]),
        ['hetzner-fsn1  default  Falkenstein (Hetzner)', 'ovh-lim'],
    );
});
