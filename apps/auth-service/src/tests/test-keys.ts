import { generateKeyPairSync } from 'node:crypto';

// Generates a fresh RSA-2048 keypair for tests. Returns PEM strings in the
// formats the production code expects (PKCS#8 private; SPKI public).
export function generateTestKeyPair(): { privatePem: string; publicPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privatePem: privateKey, publicPem: publicKey };
}
