import { exportPKCS8, exportSPKI, generateKeyPair, importPKCS8, SignJWT } from 'jose';
import type {
  EffectiveAuthorizationInput,
  EffectiveAuthorizationResolution,
  EffectiveAuthorizationResolver,
} from '@aramo/auth';

// HF-AUTH-1 — the SINGLE shared test-auth harness.
//
// Before HF-AUTH-1 every api integration spec minted its own token with an inline
// `new SignJWT({ ...scopes })` — embedding the effective scope list in the token.
// The compact token carries NO scopes; the guard resolves them server-side. This
// harness replaces the anti-pattern with ONE substrate so the old scope-in-token
// shape can never silently return:
//   - `signCompactAccessToken(...)` mints a COMPACT token (authz_version, no scopes).
//   - `ConfigurableTestResolver` implements the app-layer resolver port: a spec
//     declares "principal P in tenant T has scopes [...]" via `grant(...)`, and the
//     guard hydrates AuthContext.scopes from it — no RBAC seeding required for
//     feature specs. (The dedicated authz-version/revocation/fail-closed proofs use
//     the REAL identity-backed resolver against a seeded DB; this configurable one
//     is for the feature specs that merely need a principal to hold scopes.)
//
// A spec binds the resolver by overriding the EFFECTIVE_AUTHORIZATION_RESOLVER
// token in its testing module:
//   Test.createTestingModule({ imports: [AppModule] })
//     .overrideProvider(EFFECTIVE_AUTHORIZATION_RESOLVER).useValue(resolver)

export const TEST_AUTH_ISSUER = 'Aramo Core Auth';
export const TEST_AUTH_ALG = 'RS256';

export interface TestKeyPair {
  privatePem: string;
  publicPem: string;
}

// Generate an RS256 keypair whose PEMs are dropped into AUTH_PRIVATE_KEY /
// AUTH_PUBLIC_KEY for a spec, so the guard verifies harness-minted tokens.
export async function generateTestKeyPair(): Promise<TestKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair(TEST_AUTH_ALG, { extractable: true });
  const privatePem = await exportPKCS8(privateKey);
  const publicPem = await exportSPKI(publicKey);
  return { privatePem, publicPem };
}

export interface CompactTokenInput {
  privatePem: string;
  audience: string;
  sub: string;
  tenant_id: string;
  consumer_type?: 'recruiter' | 'portal' | 'ingestion' | 'platform';
  authz_version?: number;
  site_id?: string;
  ttlSeconds?: number;
}

// Mint a COMPACT access token — identity + authz_version, NO scopes claim (matches
// the production issuer). The harness deliberately provides no way to embed scopes.
export async function signCompactAccessToken(input: CompactTokenInput): Promise<string> {
  const signingKey = await importPKCS8(input.privatePem, TEST_AUTH_ALG);
  const now = Math.floor(Date.now() / 1000);
  const ttl = input.ttlSeconds ?? 900;
  return new SignJWT({
    sub: input.sub,
    actor_kind: 'user',
    consumer_type: input.consumer_type ?? 'recruiter',
    tenant_id: input.tenant_id,
    authz_version: input.authz_version ?? 1,
    ...(input.site_id !== undefined ? { site_id: input.site_id } : {}),
  })
    .setProtectedHeader({ alg: TEST_AUTH_ALG, typ: 'JWT' })
    .setIssuer(TEST_AUTH_ISSUER)
    .setAudience(input.audience)
    .setSubject(input.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(signingKey);
}

// A resolver a spec configures directly — the effective scopes a principal holds,
// bypassing RBAC. Also supports declaring `stale`/`unresolvable` for a principal so
// the security-behaviour specs can assert the guard's response without touching the
// real cache/DB.
//
// KEY DESIGN: `grant` allocates a FRESH authz_version per token and keys the scopes
// by (tenant, principal, version), returning the version to stamp into that token.
// This means the SAME principal minted twice with DIFFERENT scopes (a common
// integration-spec pattern — e.g. a scoped vs an unscoped token for one user) each
// resolves to exactly its own set, with no last-grant-wins collision.
export class ConfigurableTestResolver implements EffectiveAuthorizationResolver {
  private counter = 0;
  private readonly byVersion = new Map<string, string[]>();
  private readonly forced = new Map<string, 'stale' | 'unresolvable'>();

  // Allocate a fresh authz_version, register this token's scopes under it, and
  // return the version to stamp into the token (`authz_version`). The guard passes
  // that version back on resolve, so each token recovers exactly its own scopes.
  grant(tenant_id: string, principal_id: string, scopes: string[]): number {
    const version = ++this.counter;
    this.byVersion.set(this.vkey(tenant_id, principal_id, version), [...scopes]);
    return version;
  }

  // Force a non-ok resolution for a principal (behaviour specs). Takes precedence
  // over any granted scopes.
  force(tenant_id: string, principal_id: string, status: 'stale' | 'unresolvable'): this {
    this.forced.set(this.key(tenant_id, principal_id), status);
    return this;
  }

  async resolve(input: EffectiveAuthorizationInput): Promise<EffectiveAuthorizationResolution> {
    const forced = this.forced.get(this.key(input.tenant_id, input.principal_id));
    if (forced !== undefined) return { status: forced };
    const scopes = this.byVersion.get(
      this.vkey(input.tenant_id, input.principal_id, input.token_authz_version),
    );
    return { status: 'ok', scopes: scopes ?? [] };
  }

  private key(tenant_id: string, principal_id: string): string {
    return `${tenant_id}:${principal_id}`;
  }

  private vkey(tenant_id: string, principal_id: string, version: number): string {
    return `${tenant_id}:${principal_id}:${String(version)}`;
  }
}
