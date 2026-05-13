import { describe, expect, it, vi } from 'vitest';
import type { IdentityAuditService, RoleService } from '@aramo/identity';
import type { RefreshTokenDto, RefreshTokenService } from '@aramo/auth-storage';
import { RotationRaceError } from '@aramo/auth-storage';

import type { JwtIssuerService } from '../app/auth/jwt-issuer.service.js';
import { RefreshOrchestratorService } from '../app/auth/refresh-orchestrator.service.js';

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
      getScopesByUserAndTenant: vi
        .fn()
        .mockResolvedValue(['auth:session:read']),
    } as unknown as RoleService,
    jwtIssuer: {
      sign: vi.fn().mockResolvedValue('signed.jwt'),
    } as unknown as JwtIssuerService,
    audit: {
      writeEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as IdentityAuditService,
    ...overrides,
  };
}

function makeSvc(mocks: Mocks): RefreshOrchestratorService {
  return new RefreshOrchestratorService(
    mocks.refreshTokens,
    mocks.role,
    mocks.jwtIssuer,
    mocks.audit,
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
});
