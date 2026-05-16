import { generateKeyPairSync } from 'node:crypto';

import { SignJWT, importPKCS8 } from 'jose';

// PR-M0R-1 Pact provider auth helpers.
//
// Per directive §7 (Charter Refusal Commitments at Risk):
//   "Test tokens issued by auth-helpers.ts must use distinct issuer/audience
//    values from production tokens."
//
// Production auth-service signs with iss="Aramo Core Auth" and audience
// AUTH_AUDIENCE. The constants below are deliberately different so test
// tokens cannot be mistaken for production tokens by downstream verifiers.

export const TEST_ISSUER = 'Aramo Core Auth TEST';
export const TEST_AUDIENCE = 'aramo-pact-test-audience';
export const TEST_ACCESS_TTL_SECONDS = 300; // 5 minutes — short-lived per §4

export interface TestKeyPair {
  privatePem: string;
  publicPem: string;
}

export function generateTestKeyPair(): TestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privatePem: privateKey, publicPem: publicKey };
}

export interface TestAccessTokenInput {
  sub: string;
  consumer_type: 'recruiter' | 'portal' | 'ingestion';
  tenant_id: string;
  scopes: string[];
  privatePem: string;
}

// Issues a short-lived test access JWT signed with the supplied test key.
// The token's `iss` and `aud` claims use the TEST_* constants above, NOT
// the production constants. Reserved for state-handler use (e.g. seeding
// an access cookie for /session interactions in follow-on PRs); not used
// by PR-M0R-1's minimum-viable interaction set.
export async function issueTestAccessToken(input: TestAccessTokenInput): Promise<string> {
  const signingKey = await importPKCS8(input.privatePem, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: input.sub,
    actor_kind: 'user',
    consumer_type: input.consumer_type,
    tenant_id: input.tenant_id,
    scopes: input.scopes,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_AUDIENCE)
    .setSubject(input.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + TEST_ACCESS_TTL_SECONDS)
    .sign(signingKey);
}
