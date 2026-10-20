import type { IdentityProviderPolicyService } from '@aramo/identity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TenantEntitlementReader,
  AuthorizationVersionService,
  IdentityAuditService,
  IdentityService,
  RoleService,
  TenantService,
} from '@aramo/identity';
import type { RefreshTokenDto, RefreshTokenService } from '@aramo/auth-storage';
import { RotationRaceError } from '@aramo/auth-storage';
import type { JwtIssuerService } from '@aramo/auth-core';
import { RefreshOrchestratorService } from '@aramo/auth-core';

import { IdentityAuditSinkAdapter } from '../app/auth/identity-audit-sink.adapter.js';
import { IdentityPrincipalDirectoryAdapter } from '../app/auth/identity-principal-directory.adapter.js';

// Auth-Decoupling PR-4 (§3.1) — PROVIDER SUBSTITUTION ONLY. Refresh now depends on
// PrincipalDirectory.resolveScopes + AuditSink; makeSvc wraps the SAME role + audit
// mocks in the REAL adapters (resolveScopes touches only role; identity/tenant are
// unreached stubs). Every assertion — role calls, audit calls, result — is unchanged.

const USER_ID = '01900000-0000-7000-8000-000000000001';
const TENANT_ID = '01900000-0000-7000-8000-0000000000aa';
const TOKEN_ID = '01900000-0000-7000-8000-0000000000bb';

function makeDto(overrides: Partial<RefreshTokenDto> = {}): RefreshTokenDto {
  const futureExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  return {
    id: TOKEN_ID,
    user_id: USER_ID,
    tenant_id: TENANT_ID,
    consumer_type: 'recruiter',
    token_hash: 'h',
    created_at: '2026-05-13T00:00:00.000Z',
    updated_at: '2026-05-13T00:00:00.000Z',
    expires_at: futureExpires,
    revoked_at: null,
    replaced_by_id: null,
    ...overrides,
  };
}

interface Mocks {
  refreshTokens: RefreshTokenService;
  role: RoleService;
  jwtIssuer: JwtIssuerService;
  audit: IdentityAuditService;
  // IC-2 PR-5 — resolveScopes now re-proves eligibility through identity + tenant.
  identity: IdentityService;
  tenant: TenantService;
  entitlements: TenantEntitlementReader;
}

function makeMocks(overrides: Partial<Mocks> = {}): Mocks {
  return {
    refreshTokens: {
      findByHash: vi.fn().mockResolvedValue(makeDto()),
      detectReuse: vi.fn().mockResolvedValue(false),
      rotate: vi.fn().mockResolvedValue({
        new_token: makeDto({ id: 'new-id', token_hash: 'h2' }),
        old_token: makeDto({
          revoked_at: new Date().toISOString(),
          replaced_by_id: 'new-id',
        }),
      }),
      revokeAllForUser: vi.fn().mockResolvedValue({ revoked_count: 3 }),
      create: vi.fn(),
      revoke: vi.fn(),
    } as unknown as RefreshTokenService,
    role: {
      // PR-A1a-3 Ruling 2 (tenant-wide byte-identity): default mock
      // returns null → orchestrator takes the existing tenant-wide
      // path; existing assertions unchanged.
      findActiveMembershipSite: vi.fn().mockResolvedValue(null),
      getScopesByUserAndTenant: vi
        .fn()
        .mockResolvedValue(['auth:session:read']),
      getScopesByUserTenantAndSite: vi
        .fn()
        .mockResolvedValue(['auth:session:read']),
    } as unknown as RoleService,
    jwtIssuer: {
      sign: vi.fn().mockResolvedValue('signed.jwt'),
    } as unknown as JwtIssuerService,
    audit: {
      writeEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as IdentityAuditService,
    identity: {
      findUserById: vi.fn().mockResolvedValue({ id: USER_ID, is_active: true }),
    } as unknown as IdentityService,
    tenant: {
      getTenantsByUser: vi.fn().mockResolvedValue([{ id: TENANT_ID, name: 'Tenant One', status: 'ACTIVE' }]),
    } as unknown as TenantService,
    entitlements: { getCapabilities: async () => new Set(['core', 'ats', 'portal']) } as unknown as TenantEntitlementReader,
    ...overrides,
  };
}

function makeSvc(mocks: Mocks): RefreshOrchestratorService {
  const principals = new IdentityPrincipalDirectoryAdapter(
    mocks.identity, // IC-2 PR-5: resolveScopes re-proves eligibility (user + membership + status)
    mocks.tenant,
    mocks.role,
    {} as IdentityAuditService,
    { getCurrentVersion: async () => 1 } as unknown as AuthorizationVersionService,
    mocks.entitlements,
    { evaluate: async () => ({ ok: true, pinned_now: false }), recordLinkIdp: async () => undefined } as unknown as IdentityProviderPolicyService,
  );
  const auditSink = new IdentityAuditSinkAdapter(mocks.audit);
  return new RefreshOrchestratorService(
    mocks.refreshTokens,
    principals,
    mocks.jwtIssuer,
    auditSink,
  );
}

describe('RefreshOrchestratorService.handleRefresh', () => {
  // Test 32: normal refresh.
  it('orchestrates normal refresh: re-derive scopes, rotate, sign, audit', async () => {
    const mocks = makeMocks();
    const svc = makeSvc(mocks);
    const result = await svc.handleRefresh({
      consumer: 'recruiter',
      refreshCookie: 'plaintext-cookie-value',
    });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.accessJwt).toBe('signed.jwt');
    expect(typeof result.refreshTokenPlaintext).toBe('string');
    expect(mocks.role.getScopesByUserAndTenant).toHaveBeenCalledWith({
      user_id: USER_ID,
      tenant_id: TENANT_ID,
    });
    expect(mocks.refreshTokens.rotate).toHaveBeenCalled();
    expect(mocks.audit.writeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'identity.session.refreshed' }),
    );
  });

  // Test 33: detects reuse and triggers R.2 cascade with one event.
  it('detects reuse: revokes ALL tokens for user, emits ONE reuse_detected, returns token_invalid', async () => {
    const mocks = makeMocks({
      refreshTokens: {
        findByHash: vi.fn().mockResolvedValue(makeDto()),
        detectReuse: vi.fn().mockResolvedValue(true),
        revokeAllForUser: vi.fn().mockResolvedValue({ revoked_count: 5 }),
        rotate: vi.fn(),
        create: vi.fn(),
        revoke: vi.fn(),
      } as unknown as RefreshTokenService,
    });
    const svc = makeSvc(mocks);
    const result = await svc.handleRefresh({
      consumer: 'recruiter',
      refreshCookie: 'cookie',
    });
    expect(result.kind).toBe('token_invalid');
    if (result.kind !== 'token_invalid') return;
    expect(result.reason).toBe('reuse_detected');
    expect(mocks.refreshTokens.revokeAllForUser).toHaveBeenCalledWith({
      user_id: USER_ID,
    });
    expect(mocks.audit.writeEvent).toHaveBeenCalledTimes(1);
    expect(mocks.audit.writeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'identity.session.reuse_detected' }),
    );
  });

  // Test 34: consumer mismatch.
  it('rejects consumer mismatch with token_invalid (RF.1)', async () => {
    const mocks = makeMocks();
    const svc = makeSvc(mocks);
    const result = await svc.handleRefresh({
      consumer: 'portal',
      refreshCookie: 'cookie',
    });
    expect(result.kind).toBe('token_invalid');
    if (result.kind !== 'token_invalid') return;
    expect(result.reason).toBe('consumer_mismatch');
  });

  // Test 35: rotation race rolls back, returns token_invalid.
  it('handles rotation-race rollback: returns token_invalid with reason rotation_race', async () => {
    const mocks = makeMocks({
      refreshTokens: {
        findByHash: vi.fn().mockResolvedValue(makeDto()),
        detectReuse: vi.fn().mockResolvedValue(false),
        rotate: vi.fn().mockRejectedValue(new RotationRaceError()),
        revokeAllForUser: vi.fn(),
        create: vi.fn(),
        revoke: vi.fn(),
      } as unknown as RefreshTokenService,
    });
    const svc = makeSvc(mocks);
    const result = await svc.handleRefresh({
      consumer: 'recruiter',
      refreshCookie: 'cookie',
    });
    expect(result.kind).toBe('token_invalid');
    if (result.kind !== 'token_invalid') return;
    expect(result.reason).toBe('rotation_race');
  });

  it('returns token_invalid with reason cookie_missing when refreshCookie is undefined', async () => {
    const mocks = makeMocks();
    const svc = makeSvc(mocks);
    const result = await svc.handleRefresh({
      consumer: 'recruiter',
      refreshCookie: undefined,
    });
    expect(result.kind).toBe('token_invalid');
    if (result.kind !== 'token_invalid') return;
    expect(result.reason).toBe('cookie_missing');
  });

  it('returns token_invalid with reason expired when token expires_at is past', async () => {
    const mocks = makeMocks({
      refreshTokens: {
        findByHash: vi.fn().mockResolvedValue(
          makeDto({ expires_at: new Date(Date.now() - 1000).toISOString() }),
        ),
        detectReuse: vi.fn(),
        rotate: vi.fn(),
        revokeAllForUser: vi.fn(),
        create: vi.fn(),
        revoke: vi.fn(),
      } as unknown as RefreshTokenService,
    });
    const svc = makeSvc(mocks);
    const result = await svc.handleRefresh({
      consumer: 'recruiter',
      refreshCookie: 'cookie',
    });
    expect(result.kind).toBe('token_invalid');
    if (result.kind !== 'token_invalid') return;
    expect(result.reason).toBe('expired');
  });

  // PR-A1a-3 Ruling 1 (refresh threads site): membership is site-scoped
  // → refresh re-derives the SAME site_id from the (user_id, tenant_id)
  // membership row (deterministic per schema's @@unique constraint) and
  // calls the site-aware resolver; new access JWT carries site_id.
  it('PR-A1a-3 Ruling 1 — re-derives site_id at refresh for site-scoped membership', async () => {
    const SITE_ID = '01900000-0000-7000-8000-0000000000c2';
    const mocks = makeMocks();
    (mocks.role.findActiveMembershipSite as ReturnType<typeof vi.fn>)
      .mockResolvedValue(SITE_ID);
    (mocks.role.getScopesByUserTenantAndSite as ReturnType<typeof vi.fn>)
      .mockResolvedValue(['submittal:create']);
    const svc = makeSvc(mocks);

    const result = await svc.handleRefresh({
      consumer: 'recruiter',
      refreshCookie: 'cookie',
    });
    expect(result.kind).toBe('success');
    expect(mocks.role.findActiveMembershipSite).toHaveBeenCalledWith({
      user_id: USER_ID,
      tenant_id: TENANT_ID,
    });
    expect(mocks.role.getScopesByUserTenantAndSite).toHaveBeenCalledWith({
      user_id: USER_ID,
      tenant_id: TENANT_ID,
      site_id: SITE_ID,
    });
    expect(mocks.role.getScopesByUserAndTenant).not.toHaveBeenCalled();
    expect(mocks.jwtIssuer.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: USER_ID,
        tenant_id: TENANT_ID,
        site_id: SITE_ID,
        // HF-AUTH-1 — the re-minted token carries the authorization revision, not scopes.
        authz_version: 1,
      }),
    );
  });

  // PR-A1a-3 Ruling 2 (tenant-wide refresh byte-shape): tenant-wide
  // membership → refresh takes the EXISTING getScopesByUserAndTenant
  // path AND does NOT stamp site_id on the rotated access JWT. The
  // pre-A1a-3 refresh behavior is preserved byte-for-byte.
  it('PR-A1a-3 Ruling 2 — does NOT stamp site_id at refresh for tenant-wide membership', async () => {
    const mocks = makeMocks(); // findActiveMembershipSite defaults to null.
    const svc = makeSvc(mocks);

    const result = await svc.handleRefresh({
      consumer: 'recruiter',
      refreshCookie: 'cookie',
    });
    expect(result.kind).toBe('success');
    expect(mocks.role.getScopesByUserAndTenant).toHaveBeenCalledWith({
      user_id: USER_ID,
      tenant_id: TENANT_ID,
    });
    expect(mocks.role.getScopesByUserTenantAndSite).not.toHaveBeenCalled();
    const signCall = (mocks.jwtIssuer.sign as ReturnType<typeof vi.fn>).mock.calls[0]![0]!;
    expect('site_id' in signCall).toBe(false);
  });
});

// IC-2 PR-5 — refresh security: host binding (session surface) + eligibility
// re-proven before any re-mint; the presented token is revoked on a denial.
describe('IC-2 PR-5 — refresh host binding + eligibility', () => {
  const BINDING_ENV = ['AUTH_HOST_TENANT_BINDING', 'AUTH_ALLOW_UNBOUND_HOST'] as const;
  let saved: Partial<Record<string, string | undefined>> = {};
  beforeEach(() => {
    saved = {};
    for (const k of BINDING_ENV) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of BINDING_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const input = { consumer: 'recruiter' as const, refreshCookie: 'plain' };

  it('log (default): a mismatched host keeps today\'s outcome (success)', async () => {
    const mocks = makeMocks();
    const r = await makeSvc(mocks).handleRefresh({ ...input, hostClass: 'TENANT', contextId: 'other-tenant' });
    expect(r.kind).toBe('success');
  });

  it('enforce: host of ANOTHER tenant → token_invalid host_tenant_mismatch; no rotation, no re-mint', async () => {
    process.env['AUTH_HOST_TENANT_BINDING'] = 'enforce';
    const mocks = makeMocks();
    const r = await makeSvc(mocks).handleRefresh({ ...input, hostClass: 'TENANT', contextId: 'other-tenant' });
    expect(r).toEqual({ kind: 'token_invalid', reason: 'host_tenant_mismatch' });
    expect(mocks.refreshTokens.rotate).not.toHaveBeenCalled();
    expect(mocks.jwtIssuer.sign).not.toHaveBeenCalled();
  });

  it('enforce: missing/unbound host → token_invalid host_unbound unless AUTH_ALLOW_UNBOUND_HOST=true', async () => {
    process.env['AUTH_HOST_TENANT_BINDING'] = 'enforce';
    const r1 = await makeSvc(makeMocks()).handleRefresh(input);
    expect(r1).toEqual({ kind: 'token_invalid', reason: 'host_unbound' });
    process.env['AUTH_ALLOW_UNBOUND_HOST'] = 'true';
    const r2 = await makeSvc(makeMocks()).handleRefresh(input);
    expect(r2.kind).toBe('success');
  });

  it('enforce: same-tenant host → success (valid same-tenant refresh)', async () => {
    process.env['AUTH_HOST_TENANT_BINDING'] = 'enforce';
    const mocks = makeMocks();
    const r = await makeSvc(mocks).handleRefresh({ ...input, hostClass: 'TENANT', contextId: TENANT_ID });
    expect(r.kind).toBe('success');
    expect(mocks.jwtIssuer.sign).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: TENANT_ID }));
  });

  it('enforce: platform token on the PLATFORM host → success; on a TENANT host → host_class_consumer_mismatch', async () => {
    process.env['AUTH_HOST_TENANT_BINDING'] = 'enforce';
    const sentinel = '01900000-0000-7000-8000-000000000100';
    const platformMocks = () =>
      makeMocks({
        refreshTokens: {
          ...makeMocks().refreshTokens,
          findByHash: vi.fn().mockResolvedValue(makeDto({ consumer_type: 'platform', tenant_id: sentinel })),
        } as unknown as RefreshTokenService,
        tenant: { getTenantsByUser: vi.fn().mockResolvedValue([{ id: sentinel, name: 'Aramo Platform', status: 'PROVISIONED' }]) } as unknown as TenantService,
      });
    const ok = await makeSvc(platformMocks()).handleRefresh({ consumer: 'platform', refreshCookie: 'p', hostClass: 'PLATFORM', contextId: null });
    expect(ok.kind).toBe('success');
    const bad = await makeSvc(platformMocks()).handleRefresh({ consumer: 'platform', refreshCookie: 'p', hostClass: 'TENANT', contextId: TENANT_ID });
    expect(bad).toEqual({ kind: 'token_invalid', reason: 'host_tenant_mismatch' });
  });

  it.each([
    ['disabled User', { identity: { findUserById: vi.fn().mockResolvedValue({ id: USER_ID, is_active: false }) } }, 'user_inactive'],
    ['no active membership in the stored tenant', { tenant: { getTenantsByUser: vi.fn().mockResolvedValue([]) } }, 'membership_inactive'],
    ['SUSPENDED tenant', { tenant: { getTenantsByUser: vi.fn().mockResolvedValue([{ id: TENANT_ID, name: 'T', status: 'SUSPENDED' }]) } }, 'tenant_suspended'],
    ['CLOSED tenant', { tenant: { getTenantsByUser: vi.fn().mockResolvedValue([{ id: TENANT_ID, name: 'T', status: 'CLOSED' }]) } }, 'tenant_closed'],
  ] as const)('%s → token_invalid %s; presented token REVOKED; session.revoked audited; nothing re-minted', async (_l, over, reason) => {
    const mocks = makeMocks(over as unknown as Partial<Mocks>);
    const r = await makeSvc(mocks).handleRefresh(input);
    expect(r).toEqual({ kind: 'token_invalid', reason });
    expect(mocks.refreshTokens.revoke).toHaveBeenCalledWith({ id: TOKEN_ID });
    expect(mocks.refreshTokens.rotate).not.toHaveBeenCalled();
    expect(mocks.jwtIssuer.sign).not.toHaveBeenCalled();
    expect(mocks.audit.writeEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'identity.session.revoked', payload: expect.objectContaining({ reason: `refresh_denied:${reason}` }) }),
    );
  });

  it('a stored token whose tenant is NOT the user\'s owning tenant cannot re-mint that tenant (membership_inactive)', async () => {
    const mocks = makeMocks({
      refreshTokens: {
        ...makeMocks().refreshTokens,
        findByHash: vi.fn().mockResolvedValue(makeDto({ tenant_id: 'foreign-tenant' })),
      } as unknown as RefreshTokenService,
    });
    const r = await makeSvc(mocks).handleRefresh(input);
    expect(r).toEqual({ kind: 'token_invalid', reason: 'membership_inactive' });
    expect(mocks.jwtIssuer.sign).not.toHaveBeenCalled();
  });
});

// IC-2 PR-6 — refresh cannot resurrect a revoked product capability.
describe('IC-2 PR-6 — refresh re-proves the consumer\'s product capability', () => {
  it('ats entitlement removed → token_invalid consumer_not_entitled; presented token REVOKED; nothing re-minted', async () => {
    const mocks = makeMocks({ entitlements: { getCapabilities: async () => new Set(['core', 'portal']) } as unknown as TenantEntitlementReader });
    const r = await makeSvc(mocks).handleRefresh({ consumer: 'recruiter', refreshCookie: 'plain' });
    expect(r).toEqual({ kind: 'token_invalid', reason: 'consumer_not_entitled' });
    expect(mocks.refreshTokens.revoke).toHaveBeenCalledWith({ id: TOKEN_ID });
    expect(mocks.jwtIssuer.sign).not.toHaveBeenCalled();
  });
  it('esign refresh on an ATS-only tenant → consumer_not_entitled; with esign → success', async () => {
    const esignDto = () => makeDto({ consumer_type: 'sign' });
    const base = () => ({ ...makeMocks().refreshTokens, findByHash: vi.fn().mockResolvedValue(esignDto()) } as unknown as RefreshTokenService);
    const denied = await makeSvc(makeMocks({ refreshTokens: base() })).handleRefresh({ consumer: 'sign', refreshCookie: 'p' });
    expect(denied).toEqual({ kind: 'token_invalid', reason: 'consumer_not_entitled' });
    const ok = await makeSvc(makeMocks({ refreshTokens: base(), entitlements: { getCapabilities: async () => new Set(['core', 'sign']) } as unknown as TenantEntitlementReader })).handleRefresh({ consumer: 'sign', refreshCookie: 'p' });
    expect(ok.kind).toBe('success');
  });
});
