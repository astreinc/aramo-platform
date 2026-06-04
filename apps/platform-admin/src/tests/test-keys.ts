import { generateKeyPairSync } from 'node:crypto';

// Mirrors apps/auth-service/src/tests/test-keys.ts. Fresh RSA-2048 keypair
// for tests; PKCS#8 private + SPKI public PEM strings.
export function generateTestKeyPair(): { privatePem: string; publicPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privatePem: privateKey, publicPem: publicKey };
}
