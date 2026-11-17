import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketEnv, mergeEnv, s3Endpoint } from './buckets.js';

const access = { endpoint: 'https://acme-site.s3.openupstream.app', region: 'garage', accessKeyId: 'GK123', secretAccessKey: 'abc/+=' };

test('what an S3 client reads: the key, the region, the endpoint above the Bucket and its name', () => {
    assert.deepEqual(bucketEnv({ name: 'acme-site', access }), {
        ok: true,
        value: [
            { name: 'AWS_ACCESS_KEY_ID', value: 'GK123' },
            { name: 'AWS_SECRET_ACCESS_KEY', value: 'abc/+=' },
            { name: 'AWS_REGION', value: 'garage' },
            { name: 'AWS_DEFAULT_REGION', value: 'garage' },
            { name: 'AWS_ENDPOINT_URL_S3', value: 'https://s3.openupstream.app' },
            { name: 'BUCKET_NAME', value: 'acme-site' },
        ],
    });
    assert.equal(s3Endpoint('s3', 'https://s3.s3.openupstream.app'), 'https://s3.openupstream.app');
});

test('a key that may only read gets no variables', () => {
    const { secretAccessKey: _, ...readOnly } = access;
    const result = bucketEnv({ name: 'acme-site', access: readOnly });
    assert.ok(!result.ok && /openupstream:write/.test(result.error));
});

test('an env file gets the variables and keeps what else it holds', () => {
    const entries = [
        { name: 'AWS_REGION', value: 'garage' },
        { name: 'BUCKET_NAME', value: 'acme-site' },
    ];
    assert.equal(mergeEnv('', entries), 'AWS_REGION=garage\nBUCKET_NAME=acme-site\n');
    assert.equal(
        mergeEnv('# app\nPORT=8080\nexport AWS_REGION="eu-west-1"\nAWS_REGION_NAME=x\n  AWS_REGION = old\n', entries),
        '# app\nPORT=8080\nAWS_REGION=garage\nAWS_REGION_NAME=x\nBUCKET_NAME=acme-site\n',
    );
    assert.equal(mergeEnv('PORT=8080', entries), 'PORT=8080\nAWS_REGION=garage\nBUCKET_NAME=acme-site\n');
    // Twice gives the same file.
    assert.equal(mergeEnv(mergeEnv('PORT=8080\n', entries), entries), mergeEnv('PORT=8080\n', entries));
});

test('a value with other than plain characters is quoted', () => {
    assert.equal(mergeEnv('', [{ name: 'A', value: "it's $HOME" }]), "A='it'\\''s $HOME'\n");
    assert.equal(mergeEnv('', [{ name: 'A', value: 'abc/+=' }]), 'A=abc/+=\n');
});
