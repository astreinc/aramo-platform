import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  IdentityAuditService,
  IdentityService,
  RoleService,
  TenantService,
} from '@aramo/identity';
import type { RefreshTokenDto, RefreshTokenService } from '@aramo/auth-storage';
import { AuthController } from '@aramo/auth-core';
import type { CookieVerifierService } from '@aramo/auth-core';
import type { HostBaseResolver } from '@aramo/auth-core';
import type { JwtIssuerService } from '@aramo/auth-core';
import type { PkceService } from '@aramo/auth-core';
import { RefreshOrchestratorService } from '@aramo/auth-core';
import { SessionOrchestratorService } from '@aramo/auth-core';

import { IdentityPrincipalDirectoryAdapter } from '../app/auth/identity-principal-directory.adapter.js';
import { IdentityAuditSinkAdapter } from '../app/auth/identity-audit-sink.adapter.js';

// Auth-Decoupling PR-4 §3.3 — AuditSink MUST NEVER THROW (R-P4-2). Unit mapping +
// the load-bearing case: an audit failure must NOT break login / refresh / logout.

const USER_ID = '01900000-0000-7000-8000-000000000001';
const TENANT_ID = '01900000-0000-7000-8000-0000000000aa';

function throwingAudit(): IdentityAuditService {
  return {
    writeEvent: vi.fn().mockRejectedValue(new Error('audit repo down')),
    writeGlobalEvent: vi.fn().mockRejectedValue(new Error('audit repo down')),
  } as unknown as IdentityAuditService;
}

describe('IdentityAuditSinkAdapter — mapping + never-throw', () => {
  it('context_id present → writeEvent with tenant_id + actor_type user', async () => {
    const writeEvent = vi.fn().mockResolvedValue(undefined);
    const sink = new IdentityAuditSinkAdapter({ writeEvent } as unknown as IdentityAuditService);
    await sink.record({
      event_type: 'identity.session.issued',
      actor_id: USER_ID,
      context_id: TENANT_ID,
      subject_id: USER_ID,
      payload: { refresh_token_id: 'rt-1' },
    });
    expect(writeEvent).toHaveBeenCalledWith({
      event_type: 'identity.session.issued',
      actor_type: 'user',
      actor_id: USER_ID,
      tenant_id: TENANT_ID,
      subject_id: USER_ID,
      payload: { refresh_token_id: 'rt-1' },
    });
  });

  it('context_id absent → writeGlobalEvent; payload defaults to {}', async () => {
    const writeGlobalEvent = vi.fn().mockResolvedValue(undefined);
    const sink = new IdentityAuditSinkAdapter({
      writeGlobalEvent,
    } as unknown as IdentityAuditService);
    await sink.record({ event_type: 'identity.session.issued', actor_id: USER_ID, subject_id: USER_ID });
    expect(writeGlobalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ actor_type: 'user', payload: {} }),
    );
  });

  it('underlying throws → record RESOLVES (never throws)', async () => {
    const sink = new IdentityAuditSinkAdapter(throwingAudit());
    await expect(
      sink.record({ event_type: 'identity.session.issued', actor_id: USER_ID, context_id: TENANT_ID, subject_id: USER_ID }),
    ).resolves.toBeUndefined();
  });
});

// ── §3.3 composition: a throwing audit does not break the three flows ──────────

const REDIRECT_ENV = ['AUTH_COGNITO_DOMAIN', 'AUTH_COGNITO_CLIENT_ID', 'AUTH_COGNITO_REDIRECT_URI'];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  vi.clearAllMocks();
  saved = {};
  for (const k of REDIRECT_ENV) saved[k] = process.env[k];
  process.env['AUTH_COGNITO_DOMAIN'] = 'auth.example.com';
  process.env['AUTH_COGNITO_CLIENT_ID'] = 'cid';
  process.env['AUTH_COGNITO_REDIRECT_URI'] = 'https://x.example/cb';
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ id_token: 'cognito.id.token' }) }),
  );
});

function happyPrincipals(): IdentityPrincipalDirectoryAdapter {
  const identity = {
    resolveUser: vi.fn().mockResolvedValue({ id: USER_ID }),
    findUserByEmail: vi.fn(),
    linkExternalIdentity: vi.fn(),
    activateAcceptedMembershipsOnSession: vi.fn().mockResolvedValue({ activated: 0 }),
  } as unknown as IdentityService;
  const tenant = {
    getTenantsByUser: vi.fn().mockResolvedValue([{ id: TENANT_ID, name: 'T', status: 'ACTIVE' }]),
  } as unknown as TenantService;
  const role = {
    findActiveMembershipSite: vi.fn().mockResolvedValue(null),
    getScopesByUserAndTenant: vi.fn().mockResolvedValue(['auth:session:read']),
    getScopesByUserTenantAndSite: vi.fn(),
  } as unknown as RoleService;
  return new IdentityPrincipalDirectoryAdapter(identity, tenant, role, throwingAudit());
}

it('§3.3 LOGIN succeeds despite a throwing audit', async () => {
  const svc = new SessionOrchestratorService(
    { decryptState: vi.fn().mockReturnValue({ verifier: 'v', state: 's', consumer: 'recruiter', issued_at: Math.floor(Date.now() / 1000) }) } as unknown as PkceService,
    { verify: vi.fn().mockResolvedValue({ sub: 'sub', email: 'a@b.c', email_verified: true, token_use: 'id' }) } as never,
    happyPrincipals(),
    { create: vi.fn().mockResolvedValue({ id: 'rt-1' }) } as unknown as RefreshTokenService,
    { sign: vi.fn().mockResolvedValue('jwt') } as unknown as JwtIssuerService,
    new IdentityAuditSinkAdapter(throwingAudit()),
  );
  const r = await svc.handleCallback({
    consumer: 'recruiter', code: 'c', state: 's', cognitoError: undefined,
    cognitoErrorDescription: undefined, pkceStateCipher: 'cipher',
  });
  expect(r.kind).toBe('success');
});

it('§3.3 REFRESH succeeds despite a throwing audit', async () => {
  const dto: RefreshTokenDto = {
    id: 'rt-1', user_id: USER_ID, tenant_id: TENANT_ID, consumer_type: 'recruiter', token_hash: 'h',
    created_at: '', updated_at: '', expires_at: new Date(Date.now() + 1e6).toISOString(), revoked_at: null, replaced_by_id: null,
  };
  const role = {
    findActiveMembershipSite: vi.fn().mockResolvedValue(null),
    getScopesByUserAndTenant: vi.fn().mockResolvedValue(['auth:session:read']),
    getScopesByUserTenantAndSite: vi.fn(),
  } as unknown as RoleService;
  const principals = new IdentityPrincipalDirectoryAdapter({} as IdentityService, {} as TenantService, role, throwingAudit());
  const svc = new RefreshOrchestratorService(
    {
      findByHash: vi.fn().mockResolvedValue(dto),
      detectReuse: vi.fn().mockResolvedValue(false),
      rotate: vi.fn().mockResolvedValue({ new_token: { ...dto, id: 'rt-2' }, old_token: dto }),
    } as unknown as RefreshTokenService,
    principals,
    { sign: vi.fn().mockResolvedValue('jwt') } as unknown as JwtIssuerService,
    new IdentityAuditSinkAdapter(throwingAudit()),
  );
  const r = await svc.handleRefresh({ consumer: 'recruiter', refreshCookie: 'cookie' });
  expect(r.kind).toBe('success');
});

it('§3.3 LOGOUT succeeds (204) despite a throwing audit', async () => {
  const res = { cookie: vi.fn(), status: vi.fn(), end: vi.fn() };
  res.status.mockReturnValue(res);
  const ctl = new AuthController(
    {} as PkceService,
    {} as SessionOrchestratorService,
    {} as RefreshOrchestratorService,
    {} as CookieVerifierService,
    {
      findByHash: vi.fn().mockResolvedValue({ id: 'rt-1', user_id: USER_ID, tenant_id: TENANT_ID, consumer_type: 'recruiter' }),
      revoke: vi.fn().mockResolvedValue(undefined),
    } as unknown as RefreshTokenService,
    new IdentityAuditSinkAdapter(throwingAudit()),
    { resolve: vi.fn() } as unknown as HostBaseResolver,
  );
  await ctl.logout('recruiter', { cookies: { aramo_refresh: 'cookie' }, requestId: 'r' } as never, res as never);
  expect(res.status).toHaveBeenCalledWith(204);
});
