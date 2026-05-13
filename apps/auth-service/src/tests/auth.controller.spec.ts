import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import type { IdentityAuditService } from '@aramo/identity';
import type { RefreshTokenDto, RefreshTokenService } from '@aramo/auth-storage';

import { AuthController } from '../app/auth/auth.controller.js';
import type { CookieVerifierService } from '../app/auth/cookie-verifier.service.js';
import type { PkceService } from '../app/auth/pkce.service.js';
import type { RefreshOrchestratorService } from '../app/auth/refresh-orchestrator.service.js';
import type { SessionOrchestratorService } from '../app/auth/session-orchestrator.service.js';

const USER_ID = '01900000-0000-7000-8000-000000000001';
const TENANT_ID = '01900000-0000-7000-8000-0000000000aa';

interface FakeResponse {
  cookie: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  redirect: ReturnType<typeof vi.fn>;
}

function makeRes(): FakeResponse {
  const res = {
    cookie: vi.fn(),
    status: vi.fn(),
    end: vi.fn(),
    redirect: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res as FakeResponse;
}

function makeController(
  overrides: Partial<{
    pkce: PkceService;
    sessionOrch: SessionOrchestratorService;
    refreshOrch: RefreshOrchestratorService;
    cookieVerifier: CookieVerifierService;
    refreshTokens: RefreshTokenService;
    audit: IdentityAuditService;
  }> = {},
): AuthController {
  return new AuthController(
    overrides.pkce ?? ({} as PkceService),
    overrides.sessionOrch ?? ({} as SessionOrchestratorService),
    overrides.refreshOrch ?? ({} as RefreshOrchestratorService),
    overrides.cookieVerifier ?? ({} as CookieVerifierService),
    overrides.refreshTokens ?? ({} as RefreshTokenService),
    overrides.audit ?? ({} as IdentityAuditService),
  );
}

describe('AuthController.session', () => {
  // Test 36: /session verifies cookie, returns 6-field SessionResponse.
  it('returns the 6-field SessionResponseDto on successful verification', async () => {
    const cookieVerifier = {
      verify: vi.fn().mockResolvedValue({
        sub: USER_ID,
        consumer_type: 'recruiter',
        tenant_id: TENANT_ID,
        scopes: ['auth:session:read'],
        iat: 1_700_000_000,
        exp: 1_700_000_900,
      }),
    } as unknown as CookieVerifierService;
    const ctl = makeController({ cookieVerifier });
    const req = {
      cookies: { aramo_access_token: 'a.jwt' },
      requestId: 'req-1',
    } as never;
    const result = await ctl.session('recruiter', req);
    expect(Object.keys(result).sort()).toEqual([
      'consumer_type',
      'exp',
      'iat',
      'scopes',
      'sub',
      'tenant_id',
    ]);
    expect(result.sub).toBe(USER_ID);
    expect(result.consumer_type).toBe('recruiter');
  });

  // Test 37: consumer mismatch → INVALID_TOKEN.
  it('throws AramoError(INVALID_TOKEN, 401) on path/JWT consumer mismatch', async () => {
    const cookieVerifier = {
      verify: vi.fn().mockResolvedValue({
        sub: USER_ID,
        consumer_type: 'portal',
        tenant_id: TENANT_ID,
        scopes: [],
        iat: 1,
        exp: 2,
      }),
    } as unknown as CookieVerifierService;
    const ctl = makeController({ cookieVerifier });
    const req = {
      cookies: { aramo_access_token: 'jwt' },
      requestId: 'r',
    } as never;
    await expect(ctl.session('recruiter', req)).rejects.toBeInstanceOf(AramoError);
    await expect(ctl.session('recruiter', req)).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
      statusCode: 401,
    });
  });

  it('throws AramoError(INVALID_TOKEN, 401) when access cookie is missing', async () => {
    const cookieVerifier = {
      verify: vi.fn(),
    } as unknown as CookieVerifierService;
    const ctl = makeController({ cookieVerifier });
    const req = { cookies: {}, requestId: 'r' } as never;
    await expect(ctl.session('recruiter', req)).rejects.toMatchObject({
      code: 'INVALID_TOKEN',
      statusCode: 401,
    });
  });
});

describe('AuthController.logout (idempotent)', () => {
  // Test 38: logout returns 204 even with missing cookie.
  it('returns 204 and clears cookies even with missing refresh cookie', async () => {
    const refreshTokens = {
      findByHash: vi.fn(),
      revoke: vi.fn(),
    } as unknown as RefreshTokenService;
    const audit = {
      writeEvent: vi.fn(),
    } as unknown as IdentityAuditService;
    const ctl = makeController({ refreshTokens, audit });
    const res = makeRes();
    const req = { cookies: {}, requestId: 'r' } as never;

    await ctl.logout('recruiter', req, res as never);

    expect(refreshTokens.findByHash).not.toHaveBeenCalled();
    expect(audit.writeEvent).not.toHaveBeenCalled();
    expect(res.cookie).toHaveBeenCalledTimes(2); // clear access + refresh
    expect(res.status).toHaveBeenCalledWith(204);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it('revokes the matching token and emits identity.session.revoked when cookie present', async () => {
    const found: RefreshTokenDto = {
      id: 'rt-1',
      user_id: USER_ID,
      tenant_id: TENANT_ID,
      consumer_type: 'recruiter',
      token_hash: 'h',
      created_at: '',
      updated_at: '',
      expires_at: '',
      revoked_at: null,
      replaced_by_id: null,
    };
    const refreshTokens = {
      findByHash: vi.fn().mockResolvedValue(found),
      revoke: vi.fn().mockResolvedValue(found),
    } as unknown as RefreshTokenService;
    const audit = {
      writeEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as IdentityAuditService;
    const ctl = makeController({ refreshTokens, audit });
    const res = makeRes();
    const req = {
      cookies: { aramo_refresh_token: 'plaintext' },
      requestId: 'r',
    } as never;

    await ctl.logout('recruiter', req, res as never);

    expect(refreshTokens.revoke).toHaveBeenCalledWith({ id: 'rt-1' });
    expect(audit.writeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'identity.session.revoked',
        actor_type: 'user',
        payload: { reason: 'logout' },
      }),
    );
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('skips revocation silently when refresh-token consumer does not match path consumer (LO.2.s)', async () => {
    const found: RefreshTokenDto = {
      id: 'rt-1',
      user_id: USER_ID,
      tenant_id: TENANT_ID,
      consumer_type: 'portal',
      token_hash: 'h',
      created_at: '',
      updated_at: '',
      expires_at: '',
      revoked_at: null,
      replaced_by_id: null,
    };
    const refreshTokens = {
      findByHash: vi.fn().mockResolvedValue(found),
      revoke: vi.fn(),
    } as unknown as RefreshTokenService;
    const audit = {
      writeEvent: vi.fn(),
    } as unknown as IdentityAuditService;
    const ctl = makeController({ refreshTokens, audit });
    const res = makeRes();
    const req = {
      cookies: { aramo_refresh_token: 'plaintext' },
      requestId: 'r',
    } as never;

    await ctl.logout('recruiter', req, res as never);

    expect(refreshTokens.revoke).not.toHaveBeenCalled();
    expect(audit.writeEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(204);
  });
});

describe('AuthController.callback (orchestrator-result mapping)', () => {
  it('on success: sets access + refresh cookies, clears pkce_state, returns 204', async () => {
    const sessionOrch = {
      handleCallback: vi.fn().mockResolvedValue({
        kind: 'success',
        accessJwt: 'a.b.c',
        refreshTokenPlaintext: 'rt-plain',
      }),
    } as unknown as SessionOrchestratorService;
    const ctl = makeController({ sessionOrch });
    const res = makeRes();
    const req = {
      cookies: { aramo_pkce_state: 'cipher' },
      requestId: 'r',
    } as never;
    await ctl.callback(
      'recruiter',
      'code',
      'state',
      undefined,
      undefined,
      req,
      res as never,
    );
    // 3 cookie operations: access, refresh, clear pkce
    expect(res.cookie).toHaveBeenCalledTimes(3);
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('on tenant_selection_required: throws 409 TENANT_SELECTION_REQUIRED with tenants in details', async () => {
    const sessionOrch = {
      handleCallback: vi.fn().mockResolvedValue({
        kind: 'tenant_selection_required',
        tenants: [{ id: TENANT_ID, name: 'T1' }],
      }),
    } as unknown as SessionOrchestratorService;
    const ctl = makeController({ sessionOrch });
    const res = makeRes();
    const req = {
      cookies: { aramo_pkce_state: 'cipher' },
      requestId: 'r',
    } as never;

    await expect(
      ctl.callback(
        'recruiter',
        'code',
        'state',
        undefined,
        undefined,
        req,
        res as never,
      ),
    ).rejects.toMatchObject({
      code: 'TENANT_SELECTION_REQUIRED',
      statusCode: 409,
    });
  });
});
