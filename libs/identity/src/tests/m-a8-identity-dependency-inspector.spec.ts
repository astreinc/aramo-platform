import { describe, expect, it, vi } from 'vitest';

import { IDENTITY_DEPENDENCY_CODES, IdentityDependencyInspector, dependencyEvidence } from '../lib/privacy/identity-dependency-inspector.service.js';
import type { IdentityPoolLookup, IdentityRetirementPort } from '../lib/privacy/identity-retirement.port.js';

// Aramo-Sign-Mobile-Amendment-M-A8 §3.2 — the IdentityDependencyInspector's typed codes,
// one per signal, on a stubbed store. The real-Postgres proof is the sign-service spec
// m-a8-personal-deletion.integration.spec.ts; (b) is proven here because the one-
// membership unique index makes it impossible to seed in a real database.

const USER = 'u-1';
const TENANT = 't-1';
const SUB = 'sub-1';

interface World {
  caps: string[];
  otherMemberships: number;
  sameSubject: number;
  federatedSameEmail: number;
  platformRoles: string[];
  pool: IdentityPoolLookup;
  tenantHold: boolean;
  docHolds: number;
  documentsPresent: boolean;
  signPresent: boolean;
}

const clear = (): World => ({
  caps: ['core', 'sign'],
  otherMemberships: 0,
  sameSubject: 0,
  federatedSameEmail: 0,
  platformRoles: [],
  pool: { status: 'ok', subject_found: true, linked_providers: 0, other_users_same_email: 0 },
  tenantHold: false,
  docHolds: 0,
  documentsPresent: true,
  signPresent: true,
});

function build(w: World) {
  const queryRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (sql.includes('to_regclass')) {
      const t = String(values[0]);
      return [{ present: t.startsWith('documents') ? w.documentsPresent : w.signPresent }];
    }
    if (sql.includes('ExternalIdentityIdp')) return [{ n: BigInt(w.federatedSameEmail) }];
    if (sql.includes('DocumentArtifact')) return [{ n: BigInt(w.docHolds) }];
    return [{ n: 0n }];
  });
  const prisma = {
    user: { findUnique: vi.fn(async () => ({ email: 'Pat@Gmail.com', tenant_id: TENANT })) },
    tenant: { findUnique: vi.fn(async () => ({ legal_hold: w.tenantHold })) },
    userTenantMembership: { count: vi.fn(async () => w.otherMemberships) },
    externalIdentity: {
      findMany: vi.fn(async () => [{ provider: 'cognito', provider_subject: SUB, email_snapshot: 'pat@gmail.com' }]),
      count: vi.fn(async () => w.sameSubject),
    },
    userTenantMembershipRole: { findMany: vi.fn(async () => w.platformRoles.map((key) => ({ role: { key } }))) },
    $queryRaw: queryRaw,
  };
  const entitlements = { getCapabilities: vi.fn(async () => new Set(w.caps)) };
  const pool: IdentityRetirementPort = { lookup: vi.fn(async () => w.pool), retire: vi.fn() };
  return { inspector: new IdentityDependencyInspector(prisma as never, entitlements as never, pool), pool, prisma };
}

describe('M-A8 §3.2 — IdentityDependencyInspector', () => {
  it('no dependency: retire the identity; the pool is read by the linked Cognito sub; email normalized', async () => {
    const { inspector, pool } = build(clear());
    const r = await inspector.inspect(USER, TENANT);
    expect(r).toMatchObject({ dependencies: [], legal_hold: false, retire_identity: true, may_close_tenant: true, cognito_sub: SUB });
    expect(pool.lookup).toHaveBeenCalledWith({ cognito_sub: SUB, email: 'pat@gmail.com' });
    expect(pool.retire).not.toHaveBeenCalled();
  });

  const cases: Array<[string, (w: World) => void, string]> = [
    ['(a) another product capability', (w) => void (w.caps = ['core', 'sign', 'ats']), IDENTITY_DEPENDENCY_CODES.a],
    ['(b) an active membership in another tenant', (w) => void (w.otherMemberships = 1), IDENTITY_DEPENDENCY_CODES.b],
    ['(c) another user on the same subject', (w) => void (w.sameSubject = 1), IDENTITY_DEPENDENCY_CODES.c],
    ['(c) another user with a federated link for the email', (w) => void (w.federatedSameEmail = 1), IDENTITY_DEPENDENCY_CODES.c],
    ['(d) a platform role', (w) => void (w.platformRoles = ['support_admin']), IDENTITY_DEPENDENCY_CODES.d],
    ['(e) a linked provider in the pool', (w) => void (w.pool = { status: 'ok', subject_found: true, linked_providers: 1, other_users_same_email: 0 }), IDENTITY_DEPENDENCY_CODES.e],
    ['(e) another pool user with the email', (w) => void (w.pool = { status: 'ok', subject_found: true, linked_providers: 0, other_users_same_email: 2 }), IDENTITY_DEPENDENCY_CODES.e],
    ['(e) the pool is not configured', (w) => void (w.pool = { status: 'not_configured' }), IDENTITY_DEPENDENCY_CODES.e],
    ['(e) the pool cannot be read', (w) => void (w.pool = { status: 'failed' }), IDENTITY_DEPENDENCY_CODES.e],
  ];
  for (const [name, mutate, code] of cases) {
    it(`${name} → ${code}; the identity is retained`, async () => {
      const w = clear();
      mutate(w);
      const r = await build(w).inspector.inspect(USER, TENANT);
      expect(r.dependencies).toEqual([code]);
      expect(r.retire_identity).toBe(false);
      expect(r.legal_hold).toBe(false);
      expect(r.may_close_tenant).toBe(code !== IDENTITY_DEPENDENCY_CODES.a);
    });
  }

  it('(f) a tenant legal hold, or a DocumentArtifact hold in the tenant, holds the request', async () => {
    const t = clear();
    t.tenantHold = true;
    expect(await build(t).inspector.inspect(USER, TENANT)).toMatchObject({ legal_hold: true, retire_identity: false, dependencies: [], f_legal_hold: { tenant: true, document_artifacts: 0 } });
    const d = clear();
    d.docHolds = 2;
    expect(await build(d).inspector.inspect(USER, TENANT)).toMatchObject({ legal_hold: true, retire_identity: false, f_legal_hold: { tenant: false, document_artifacts: 2 } });
    // A database without the documents schema reads 0 document holds.
    const none = clear();
    none.docHolds = 5;
    none.documentsPresent = false;
    expect((await build(none).inspector.inspect(USER, TENANT)).legal_hold).toBe(false);
  });

  it('computed at execution time, never cached: a second call re-reads every signal', async () => {
    const w = clear();
    const { inspector, pool, prisma } = build(w);
    expect((await inspector.inspect(USER, TENANT)).retire_identity).toBe(true);
    w.caps = ['core', 'sign', 'ats'];
    expect((await inspector.inspect(USER, TENANT)).dependencies).toEqual([IDENTITY_DEPENDENCY_CODES.a]);
    expect(pool.lookup).toHaveBeenCalledTimes(2);
    expect(prisma.userTenantMembership.count).toHaveBeenCalledTimes(2);
  });

  it('a subject outside the tenant is refused (tenant isolation)', async () => {
    const { inspector } = build(clear());
    await expect(inspector.inspect(USER, 't-other')).rejects.toThrow(/subject_not_in_tenant/);
  });

  it('evidence is codes and counts only — never the subject or the email', async () => {
    const w = clear();
    w.platformRoles = ['support_admin'];
    const e = dependencyEvidence(await build(w).inspector.inspect(USER, TENANT));
    expect(e['dependency_codes']).toEqual([IDENTITY_DEPENDENCY_CODES.d]);
    expect(JSON.stringify(e)).not.toContain(SUB);
    expect(JSON.stringify(e).toLowerCase()).not.toContain('pat@gmail.com');
  });
});
