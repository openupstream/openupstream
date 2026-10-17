// Dev and test stand-in for madAuth's session tokens (ARCHITECTURE.md,
// decision 59): a key pair whose public half the control plane trusts via
// AUTH_JWKS, and tokens shaped like madAuth's (ES256, typ
// madauth-session+jwt, no audience) signed with the private half. Never for
// a real cluster; where madAuth runs, sign in with it instead.
//
//   node scripts/dev-token.mjs init <dir>              writes jwks.json and private.jwk
//   node scripts/dev-token.mjs mint <dir> <subject> [issuer]   prints a token, valid 1 hour
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SignJWT, exportJWK, generateKeyPair, importJWK } from 'jose';

const [command, dir, subject, issuer = 'http://localhost:8787'] = process.argv.slice(2);

if (command === 'init' && dir) {
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, 'jwks.json'), JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), alg: 'ES256', kid: 'dev' }] }));
    await writeFile(join(dir, 'private.jwk'), JSON.stringify(await exportJWK(privateKey)), { mode: 0o600 });
} else if (command === 'mint' && dir && subject) {
    const key = await importJWK(JSON.parse(await readFile(join(dir, 'private.jwk'), 'utf8')), 'ES256');
    const token = await new SignJWT({ email: `${subject}@dev.invalid` })
        .setProtectedHeader({ alg: 'ES256', kid: 'dev', typ: 'madauth-session+jwt' })
        .setSubject(subject)
        .setIssuer(issuer)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(key);
    process.stdout.write(`${token}\n`);
} else {
    console.error('usage: dev-token.mjs init <dir> | mint <dir> <subject> [issuer]');
    process.exit(2);
}
