import { generateKeyPairSync } from 'node:crypto';

import { SignJWT, importPKCS8 } from 'jose';
import type {
  EffectiveAuthorizationInput,
  EffectiveAuthorizationResolution,
  EffectiveAuthorizationResolver,
} from '@aramo/auth';

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
  // HF-AUTH-1 — the compact token carries an authorization REVISION, not a scope
  // list. Effective scopes are resolved server-side; a caller declares the
  // principal's scopes to the resolver (PactConfigurableResolver.grant) and passes
  // the returned version here.
  authz_version: number;
  privatePem: string;
}

// Issues a short-lived COMPACT test access JWT signed with the supplied test key.
// The token's `iss` and `aud` claims use the TEST_* constants above, NOT the
// production constants. Carries authz_version, never a scopes claim. Reserved for
// state-handler use; not used by PR-M0R-1's minimum-viable interaction set.
export async function issueTestAccessToken(input: TestAccessTokenInput): Promise<string> {
  const signingKey = await importPKCS8(input.privatePem, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: input.sub,
    actor_kind: 'user',
    consumer_type: input.consumer_type,
    tenant_id: input.tenant_id,
    authz_version: input.authz_version,
  })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(TEST_ISSUER)
    .setAudience(TEST_AUDIENCE)
    .setSubject(input.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + TEST_ACCESS_TTL_SECONDS)
    .sign(signingKey);
}

// HF-AUTH-1 — the Pact provider's app-layer resolver. The provider verifies the
// API CONTRACT (response shapes / status codes), not RBAC derivation, so it binds
// this version-keyed configurable resolver (MODE A) over the booted AppModule
// instead of seeding full RBAC for every synthetic principal: a state/fixture
// declares "principal P in tenant T holds scopes [...]" via grant(), and the guard
// hydrates AuthContext.scopes from it. grant() allocates a FRESH authz_version per
// token and keys the scopes by (tenant, principal, version), so the SAME principal
// minted with DIFFERENT scope sets (e.g. the full recruiter token vs the
// deliberately-insufficient one) each resolves to exactly its own set.
export class PactConfigurableResolver implements EffectiveAuthorizationResolver {
  private counter = 0;
  private readonly byVersion = new Map<string, string[]>();

  grant(tenant_id: string, principal_id: string, scopes: string[]): number {
    const version = ++this.counter;
    this.byVersion.set(this.vkey(tenant_id, principal_id, version), [...scopes]);
    return version;
  }

  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const scopes = this.byVersion.get(
      this.vkey(input.tenant_id, input.principal_id, input.token_authz_version),
    );
    return { status: 'ok', scopes: scopes ?? [] };
  }

  private vkey(tenant_id: string, principal_id: string, version: number): string {
    return `${tenant_id}:${principal_id}:${String(version)}`;
  }
}
