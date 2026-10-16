import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
    type KeyEncryptionKey,
    decryptSecretValue,
    encryptSecretValue,
    generateDataKey,
    parseKeyEncryptionKey,
    rewrapDataKey,
    unwrapDataKey,
    wrapDataKey,
} from './envelope.js';

const newKek = (id: string): KeyEncryptionKey => ({ id, key: randomBytes(32) });
const projectId = '0b8e6c9e-7a4f-4e39-9a7e-1f3f0d6f2a11';
const otherProjectId = '5d1c2a33-90b4-4c8f-8f3e-6c2b9d0e7f44';

test('a Secret value round-trips through the envelope', () => {
    const kek = newKek('kek-1');
    const wrapped = wrapDataKey(kek, generateDataKey(), projectId);
    const dataKey = unwrapDataKey(kek, wrapped, projectId);
    assert.ok(dataKey.ok);

    const location = { projectId, name: 'DATABASE_URL' };
    const sealed = encryptSecretValue(dataKey.value, location, 'postgres://ü@db/app');
    assert.deepEqual(decryptSecretValue(dataKey.value, location, sealed), { ok: true, value: 'postgres://ü@db/app' });
});

test('the wrapped data key does not contain the data key', () => {
    const kek = newKek('kek-1');
    const dataKey = generateDataKey();
    const wrapped = wrapDataKey(kek, dataKey, projectId);
    assert.equal(wrapped.kekId, 'kek-1');
    assert.equal(wrapped.wrapped.includes(dataKey.key), false);
});

test('encrypting the same value twice gives different ciphertexts', () => {
    const dataKey = generateDataKey();
    const location = { projectId, name: 'TOKEN' };
    assert.notDeepEqual(encryptSecretValue(dataKey, location, 'x'), encryptSecretValue(dataKey, location, 'x'));
});

test('a data key only unwraps with the KEK that wrapped it', () => {
    const wrapped = wrapDataKey(newKek('kek-1'), generateDataKey(), projectId);
    assert.deepEqual(unwrapDataKey(newKek('kek-1'), wrapped, projectId), {
        ok: false,
        error: { kind: 'authentication-failed' },
    });
    assert.deepEqual(unwrapDataKey(newKek('kek-2'), wrapped, projectId), {
        ok: false,
        error: { kind: 'kek-mismatch', expected: 'kek-1', actual: 'kek-2' },
    });
});

test('a wrapped data key copied to another Project does not unwrap', () => {
    const kek = newKek('kek-1');
    const wrapped = wrapDataKey(kek, generateDataKey(), projectId);
    assert.deepEqual(unwrapDataKey(kek, wrapped, otherProjectId), {
        ok: false,
        error: { kind: 'authentication-failed' },
    });
});

test('a Secret value moved to another name or Project does not decrypt', () => {
    const dataKey = generateDataKey();
    const sealed = encryptSecretValue(dataKey, { projectId, name: 'A' }, 'secret');
    const failed = { ok: false, error: { kind: 'authentication-failed' } };
    assert.deepEqual(decryptSecretValue(dataKey, { projectId, name: 'B' }, sealed), failed);
    assert.deepEqual(decryptSecretValue(dataKey, { projectId: otherProjectId, name: 'A' }, sealed), failed);
    assert.deepEqual(decryptSecretValue(generateDataKey(), { projectId, name: 'A' }, sealed), failed);
});

test('a tampered or truncated ciphertext is rejected', () => {
    const dataKey = generateDataKey();
    const location = { projectId, name: 'A' };
    const sealed = encryptSecretValue(dataKey, location, 'secret');

    const flipped = Buffer.from(sealed);
    flipped[20] = (flipped[20] ?? 0) ^ 1;
    assert.deepEqual(decryptSecretValue(dataKey, location, flipped), {
        ok: false,
        error: { kind: 'authentication-failed' },
    });
    assert.deepEqual(decryptSecretValue(dataKey, location, sealed.subarray(0, 20)), {
        ok: false,
        error: { kind: 'malformed' },
    });

    const otherVersion = Buffer.from(sealed);
    otherVersion[0] = 2;
    assert.deepEqual(decryptSecretValue(dataKey, location, otherVersion), { ok: false, error: { kind: 'malformed' } });
});

test('rewrapping moves a data key to a new KEK without changing it', () => {
    const oldKek = newKek('kek-1');
    const newKekValue = newKek('kek-2');
    const dataKey = generateDataKey();
    const rewrapped = rewrapDataKey(oldKek, newKekValue, wrapDataKey(oldKek, dataKey, projectId), projectId);
    assert.ok(rewrapped.ok);
    assert.equal(rewrapped.value.kekId, 'kek-2');
    assert.deepEqual(unwrapDataKey(newKekValue, rewrapped.value, projectId), { ok: true, value: dataKey });
});

test('a KEK must be 32 bytes and have an id', () => {
    const valid = randomBytes(32).toString('base64');
    assert.equal(parseKeyEncryptionKey('kek-1', valid).ok, true);
    assert.equal(parseKeyEncryptionKey('', valid).ok, false);
    assert.equal(parseKeyEncryptionKey('kek-1', randomBytes(16).toString('base64')).ok, false);
});
