import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appSecretManifests, appVerifierSalt, scramVerifier } from './credentials.js';

test('the verifier is the one Postgres stores for the password', () => {
    // RFC 7677's example password and salt; the keys as Postgres 17 stores them (checked against a login on the dev cluster, 2026-11-28).
    assert.equal(
        scramVerifier('pencil', Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64')),
        'SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=',
    );
});

test("a Database's salt never changes, and no two Databases share one", () => {
    const a = appVerifierSalt('5d1c2a33-90b4-4c8f-8f3e-6c2b9d0e7f44');
    assert.equal(a.length, 16);
    assert.deepEqual(appVerifierSalt('5d1c2a33-90b4-4c8f-8f3e-6c2b9d0e7f44'), a);
    assert.notDeepEqual(appVerifierSalt('7a2e4b55-1c3d-4e6f-8a9b-0c1d2e3f4a5b'), a);
});

test("the app user's two Secrets: the password for Services, its verifier for CloudNativePG, the same on every render", () => {
    const credentials = { databaseId: '5d1c2a33-90b4-4c8f-8f3e-6c2b9d0e7f44', password: 'kZ3-password_of-32-url-safe-chars' };
    const [plain, verifier] = appSecretManifests('p1', credentials);
    const decoded = (value: string | undefined) => Buffer.from(value ?? '', 'base64').toString('utf8');
    assert.deepEqual([plain?.metadata.namespace, plain?.metadata.name, plain?.type], ['project-p1', `db-${credentials.databaseId}-app`, 'kubernetes.io/basic-auth']);
    assert.deepEqual([decoded(plain?.data['username']), decoded(plain?.data['password'])], ['app', credentials.password]);
    assert.equal(verifier?.metadata.name, `db-${credentials.databaseId}-app-scram`);
    assert.equal(decoded(verifier?.data['username']), 'app');
    assert.match(decoded(verifier?.data['password']), /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    assert.equal(verifier?.metadata.labels?.['cnpg.io/reload'], 'true');
    assert.deepEqual(appSecretManifests('p1', credentials), [plain, verifier], 'a new salt would make PgBouncer fail its next login');
});
