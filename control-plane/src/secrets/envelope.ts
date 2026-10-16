/**
 * Envelope encryption for Secrets (ARCHITECTURE.md, "Secrets").
 *
 * Every Secret value is encrypted with its Project's data key; the data key is
 * stored wrapped (encrypted) by the one key-encryption key (KEK). Both layers
 * are AES-256-GCM. The associated data binds each ciphertext to where it is
 * stored: a wrapped data key only opens for its Project, a Secret value only
 * for its Project and name, so rows cannot be swapped between Projects.
 *
 * Sealed format: version byte (1) | nonce (12) | ciphertext | GCM tag (16).
 *
 * No I/O and no state; the only side effect is reading random bytes for keys
 * and nonces.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { type Result, err, ok } from '../result.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT_VERSION = 1;
/** 32 bytes in standard base64: 43 characters and one `=`. */
const KEK_BASE64 = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

export interface KeyEncryptionKey {
    /** Stored next to every data key it wraps, so the KEK can be rotated. */
    readonly id: string;
    readonly key: Buffer;
}

export interface DataKey {
    readonly key: Buffer;
}

export interface WrappedDataKey {
    readonly kekId: string;
    readonly wrapped: Buffer;
}

/** Identifies where a Secret value is stored; part of its associated data. */
export interface SecretLocation {
    readonly projectId: string;
    readonly name: string;
}

export type EnvelopeError =
    | { readonly kind: 'invalid-key'; readonly message: string }
    | { readonly kind: 'kek-mismatch'; readonly expected: string; readonly actual: string }
    | { readonly kind: 'malformed' }
    | { readonly kind: 'authentication-failed' };

/** Reads a KEK from its base64 encoding (32 random bytes). */
export function parseKeyEncryptionKey(id: string, base64: string): Result<KeyEncryptionKey, EnvelopeError> {
    if (id.length === 0) {
        return err({ kind: 'invalid-key', message: 'the key-encryption key needs an id' });
    }
    // Buffer.from skips characters that are not base64, so check the encoding
    // first: a mangled key must not decode to a different valid one.
    if (!KEK_BASE64.test(base64)) {
        return err({ kind: 'invalid-key', message: `the key-encryption key must be ${KEY_BYTES} bytes in standard base64` });
    }
    return ok({ id, key: Buffer.from(base64, 'base64') });
}

export function generateDataKey(): DataKey {
    return { key: randomBytes(KEY_BYTES) };
}

export function wrapDataKey(kek: KeyEncryptionKey, dataKey: DataKey, projectId: string): WrappedDataKey {
    return { kekId: kek.id, wrapped: seal(kek.key, dataKey.key, dataKeyAad(projectId)) };
}

export function unwrapDataKey(
    kek: KeyEncryptionKey,
    wrapped: WrappedDataKey,
    projectId: string,
): Result<DataKey, EnvelopeError> {
    if (wrapped.kekId !== kek.id) {
        return err({ kind: 'kek-mismatch', expected: wrapped.kekId, actual: kek.id });
    }
    const opened = open(kek.key, wrapped.wrapped, dataKeyAad(projectId));
    if (!opened.ok) {
        return opened;
    }
    return opened.value.length === KEY_BYTES ? ok({ key: opened.value }) : err({ kind: 'malformed' });
}

/** Re-wraps a data key under a new KEK; the Secrets it protects stay as they are. */
export function rewrapDataKey(
    from: KeyEncryptionKey,
    to: KeyEncryptionKey,
    wrapped: WrappedDataKey,
    projectId: string,
): Result<WrappedDataKey, EnvelopeError> {
    const dataKey = unwrapDataKey(from, wrapped, projectId);
    return dataKey.ok ? ok(wrapDataKey(to, dataKey.value, projectId)) : dataKey;
}

export function encryptSecretValue(dataKey: DataKey, location: SecretLocation, value: string): Buffer {
    return seal(dataKey.key, Buffer.from(value, 'utf8'), secretAad(location));
}

export function decryptSecretValue(
    dataKey: DataKey,
    location: SecretLocation,
    sealed: Buffer,
): Result<string, EnvelopeError> {
    const opened = open(dataKey.key, sealed, secretAad(location));
    return opened.ok ? ok(opened.value.toString('utf8')) : opened;
}

const dataKeyAad = (projectId: string): Buffer => Buffer.from(`openupstream/data-key/v1/${projectId}`, 'utf8');

const secretAad = ({ projectId, name }: SecretLocation): Buffer =>
    Buffer.from(`openupstream/secret/v1/${projectId}/${name}`, 'utf8');

function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES }).setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.of(FORMAT_VERSION), nonce, ciphertext, cipher.getAuthTag()]);
}

function open(key: Buffer, sealed: Buffer, aad: Buffer): Result<Buffer, EnvelopeError> {
    if (sealed.length < 1 + NONCE_BYTES + TAG_BYTES || sealed[0] !== FORMAT_VERSION) {
        return err({ kind: 'malformed' });
    }
    const nonce = sealed.subarray(1, 1 + NONCE_BYTES);
    const ciphertext = sealed.subarray(1 + NONCE_BYTES, sealed.length - TAG_BYTES);
    const tag = sealed.subarray(sealed.length - TAG_BYTES);
    const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES })
        .setAAD(aad)
        .setAuthTag(tag);
    const plaintext = decipher.update(ciphertext);
    // node:crypto has no non-throwing GCM verify: it reports a failed check
    // only by throwing from final(). This is the one accepted exception to the
    // no-try-catch-for-branching rule in AGENTS.md; it turns the throw into a
    // result right here.
    try {
        return ok(Buffer.concat([plaintext, decipher.final()]));
    } catch {
        return err({ kind: 'authentication-failed' });
    }
}
