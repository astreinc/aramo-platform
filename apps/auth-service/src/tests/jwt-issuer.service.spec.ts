import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { ISSUER, JwtIssuerService } from '@aramo/auth-core';

import { generateTestKeyPair } from './test-keys.js';

const SUB = '01900000-0000-7000-8000-000000000001';
const TENANT = '01900000-0000-7000-8000-0000000000aa';

let savedAudience: string | undefined;
let savedPriv: string | undefined;

beforeAll(() => {
  savedAudience = process.env['AUTH_AUDIENCE'];
  savedPriv = process.env['AUTH_PRIVATE_KEY'];
  const { privatePem } = generateTestKeyPair();
  process.env['AUTH_AUDIENCE'] = 'aramo-test-audience';
  process.env['AUTH_PRIVATE_KEY'] = privatePem;
});

afterAll(() => {
  if (savedAudience === undefined) delete process.env['AUTH_AUDIENCE'];
  else process.env['AUTH_AUDIENCE'] = savedAudience;
  if (savedPriv === undefined) delete process.env['AUTH_PRIVATE_KEY'];
  else process.env['AUTH_PRIVATE_KEY'] = savedPriv;
});

describe('JwtIssuerService.sign', () => {
  // Test 21: produces a JWT with all 9 required claims + kid header.
  it('produces a JWT carrying all 9 required claims and kid header', async () => {
    const svc = new JwtIssuerService();
    const jwt = await svc.sign({
      sub: SUB,
      consumer_type: 'recruiter',
      tenant_id: TENANT,
      authz_version: 1,
    });
    const payload = decodeJwt(jwt);
    expect(payload.iss).toBe(ISSUER);
    expect(payload.aud).toBe('aramo-test-audience');
    expect(payload.sub).toBe(SUB);
    expect(payload['actor_kind']).toBe('user');
    expect(payload['consumer_type']).toBe('recruiter');
    expect(payload['tenant_id']).toBe(TENANT);
    // HF-AUTH-1 — compact token: authz_version present, NO scopes claim.
    expect(payload['authz_version']).toBe(1);
    expect(payload['scopes']).toBeUndefined();
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    // exp = iat + 900 (15 minutes)
    expect(payload.exp! - payload.iat!).toBe(900);

    const header = decodeProtectedHeader(jwt);
    expect(header.alg).toBe('RS256');
    expect(header.typ).toBe('JWT');
    expect(typeof header.kid).toBe('string');
    expect((header.kid as string).length).toBeGreaterThan(0);
  });

  // Test 22: byte-exact issuer literal matches libs/auth's ISSUER constant.
  // The verifier and issuer must agree byte-for-byte; drift would cause every
  // verification to fail.
  it('issuer literal "Aramo Core Auth" matches libs/auth ISSUER constant byte-for-byte', () => {
    // Verify against the actual file content of libs/auth/src/lib/jwt-auth.guard.ts
    // so this is not a self-referential parity check.
    const here = resolve(__dirname);
    const guardPath = resolve(
      here,
      '..',
      '..',
      '..',
      '..',
      'libs',
      'auth',
      'src',
      'lib',
      'jwt-auth.guard.ts',
    );
    const guardSrc = readFileSync(guardPath, 'utf8');
    const m = /const ISSUER = ['"]([^'"]+)['"]/.exec(guardSrc);
    expect(m).not.toBeNull();
    const verifierIssuer = m![1]!;
    expect(ISSUER).toBe(verifierIssuer);
    expect(ISSUER).toBe('Aramo Core Auth');
  });

  // Test 23: alg = RS256 (covered by test 21 header check; explicit assertion).
  it('signs with RS256 algorithm', async () => {
    const svc = new JwtIssuerService();
    const jwt = await svc.sign({
      sub: SUB,
      consumer_type: 'portal',
      tenant_id: TENANT,
      authz_version: 1,
    });
    expect(decodeProtectedHeader(jwt).alg).toBe('RS256');
  });

  // PR-A1a-3 Ruling 2 (byte-shape guarantee): when site_id is absent
  // from the issuance payload the JWT payload MUST NOT carry a site_id
  // claim. This is the headline tenant-wide-AuthN-unchanged safety
  // gate — a tenant-wide token from before A1a-3 and a tenant-wide
  // token after A1a-3 must be indistinguishable in claim shape.
  it('PR-A1a-3 Ruling 2 — no site_id in payload when site_id is omitted (tenant-wide byte-shape preserved)', async () => {
    const svc = new JwtIssuerService();
    const jwt = await svc.sign({
      sub: SUB,
      consumer_type: 'recruiter',
      tenant_id: TENANT,
      authz_version: 1,
    });
    const payload = decodeJwt(jwt);
    expect('site_id' in payload).toBe(false);
    expect(payload['site_id']).toBeUndefined();
    // The pre-A1a-3 claim set is exactly: iss, aud, sub, actor_kind,
    // consumer_type, tenant_id, authz_version, iat, exp. Lock the key set so
    // any drift fails this test loudly.
    const keys = Object.keys(payload).sort();
    expect(keys).toEqual(
      [
        'actor_kind',
        'aud',
        'consumer_type',
        'exp',
        'iat',
        'iss',
        'authz_version',
        'sub',
        'tenant_id',
      ].sort(),
    );
  });

  // PR-A1a-3 Ruling 1 (auto-stamp visibility): when site_id is provided
  // it appears as a JWT claim verbatim. JwtAuthGuard already reads
  // payload.site_id into AuthContext (auth-context.types.ts) and
  // RolesGuard enforces @RequireSiteMatch from there — this test
  // verifies the issuance side closes the A1a-2 §4 Ruling-3 finding.
  it('PR-A1a-3 Ruling 1 — site_id is emitted as a top-level JWT claim when provided', async () => {
    const svc = new JwtIssuerService();
    const SITE_ID = '01900000-0000-7000-8000-0000000000c1';
    const jwt = await svc.sign({
      sub: SUB,
      consumer_type: 'recruiter',
      tenant_id: TENANT,
      authz_version: 1,
      site_id: SITE_ID,
    });
    const payload = decodeJwt(jwt);
    expect(payload['site_id']).toBe(SITE_ID);
    // Site-stamped token shape = tenant-wide shape + EXACTLY the site_id
    // additive claim (Ruling 2: only delta permitted).
    const keys = Object.keys(payload).sort();
    expect(keys).toEqual(
      [
        'actor_kind',
        'aud',
        'consumer_type',
        'exp',
        'iat',
        'iss',
        'authz_version',
        'site_id',
        'sub',
        'tenant_id',
      ].sort(),
    );
  });
});

// HF-AUTH-1 — the token-size PROPERTY guard. The load-bearing invariant: a browser
// access token is BOUNDED and INDEPENDENT of authorization-catalog size. This is
// the permanent CI/test wall that stops the old scope-in-token design returning.
describe('JwtIssuerService — token-size property (HF-AUTH-1)', () => {
  const BUDGET = 2048; // deliberately far below the 4096 browser cookie ceiling.
  const MAXIMAL = {
    sub: '01900000-0000-7000-8000-0000000000ff',
    consumer_type: 'recruiter' as const,
    tenant_id: TENANT,
    site_id: '01900000-0000-7000-8000-0000000000c1',
  };

  it('a maximal compact token is well under the 2 KB architectural budget and carries NO scopes claim', async () => {
    const svc = new JwtIssuerService();
    const jwt = await svc.sign({ ...MAXIMAL, authz_version: 1 });
    const bytes = Buffer.byteLength(jwt, 'utf8');
    expect(bytes).toBeLessThanOrEqual(BUDGET);
    expect(bytes).toBeLessThan(4096); // never near the cookie ceiling that broke login
    expect(Object.prototype.hasOwnProperty.call(decodeJwt(jwt), 'scopes')).toBe(false);
  });

  it('token size is INDEPENDENT of authorization growth (the issuer cannot carry scopes at all)', async () => {
    const svc = new JwtIssuerService();
    // A tiny vs a very large authz_version models a catalog that has grown / been
    // revised thousands of times. The compact token stays flat — the only variance
    // permitted is the integer's decimal width. Scope-catalog growth moves NO bytes
    // into the token because the issuance payload TYPE has no scopes field.
    const small = await svc.sign({ ...MAXIMAL, authz_version: 1 });
    const large = await svc.sign({ ...MAXIMAL, authz_version: 2_147_483_647 });
    const drift = Math.abs(Buffer.byteLength(large, 'utf8') - Buffer.byteLength(small, 'utf8'));
    expect(drift).toBeLessThanOrEqual(16);
    // Structural: neither token has a scopes claim regardless of the "catalog".
    expect(Object.prototype.hasOwnProperty.call(decodeJwt(small), 'scopes')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(decodeJwt(large), 'scopes')).toBe(false);
  });
});
