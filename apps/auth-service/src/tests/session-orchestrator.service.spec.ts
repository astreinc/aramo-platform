import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  IdentityAuditService,
  IdentityService,
  RoleService,
  TenantService,
} from '@aramo/identity';
import type { RefreshTokenService } from '@aramo/auth-storage';

import type { CognitoVerifierService } from '../app/auth/cognito-verifier.service.js';
import type { JwtIssuerService } from '../app/auth/jwt-issuer.service.js';
import type { PkceService, PkceStatePayload } from '../app/auth/pkce.service.js';
import { SessionOrchestratorService } from '../app/auth/session-orchestrator.service.js';

const USER_ID = '01900000-0000-7000-8000-000000000001';
const TENANT_ID = '01900000-0000-7000-8000-0000000000aa';
const TENANT_ID_2 = '01900000-0000-7000-8000-0000000000ab';
const COGNITO_SUB = 'cognito-sub-01';

interface Mocks {
  pkce: PkceService;
  cognito: CognitoVerifierService;
  identity: IdentityService;
  tenant: TenantService;
  role: RoleService;
  refreshTokens: RefreshTokenService;
  jwtIssuer: JwtIssuerService;
  audit: IdentityAuditService;
}

function makeMocks(overrides: Partial<Mocks> = {}): Mocks {
  const decryptedPayload: PkceStatePayload = {
    verifier: 'v',
    state: 'state-1',
    consumer: 'recruiter',
    issued_at: Math.floor(Date.now() / 1000),
  };
  const base: Mocks = {
    pkce: {
      decryptState: vi.fn().mockReturnValue(decryptedPayload),
      generate: vi.fn(),
      encryptState: vi.fn(),
    } as unknown as PkceService,
    cognito: {
      verify: vi
        .fn()
        .mockResolvedValue({
          sub: COGNITO_SUB,
          email: 'a@b.c',
          email_verified: true,
          token_use: 'id',
        }),
    } as unknown as CognitoVerifierService,
    identity: {
      resolveUser: vi.fn().mockResolvedValue({
        id: USER_ID,
        email: 'a@b.c',
        display_name: null,
        is_active: true,
        deactivated_at: null,
        created_at: '',
        updated_at: '',
      }),
      // R3 reconcile-by-verified-email seam (default: no email match — the
      // success-path tests resolve by sub and never reach reconcile).
      findUserByEmail: vi.fn().mockResolvedValue(null),
      linkExternalIdentity: vi.fn().mockResolvedValue({
        id: 'ext-1',
        provider: 'cognito',
        provider_subject: COGNITO_SUB,
        user_id: USER_ID,
        email_snapshot: 'a@b.c',
        created_at: '',
        updated_at: '',
      }),
    } as unknown as IdentityService,
    tenant: {
      getTenantsByUser: vi.fn().mockResolvedValue([
        {
          id: TENANT_ID,
          name: 'Tenant One',
          is_active: true,
          created_at: '',
          updated_at: '',
        },
      ]),
    } as unknown as TenantService,
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
    refreshTokens: {
      create: vi.fn().mockResolvedValue({
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
      }),
    } as unknown as RefreshTokenService,
    jwtIssuer: {
      sign: vi.fn().mockResolvedValue('signed.jwt.value'),
    } as unknown as JwtIssuerService,
    audit: {
      writeEvent: vi.fn().mockResolvedValue(undefined),
      writeGlobalEvent: vi.fn().mockResolvedValue(undefined),
    } as unknown as IdentityAuditService,
  };
  return { ...base, ...overrides };
}

function makeService(mocks: Mocks): SessionOrchestratorService {
  return new SessionOrchestratorService(
    mocks.pkce,
    mocks.cognito,
    mocks.identity,
    mocks.tenant,
    mocks.role,
    mocks.refreshTokens,
    mocks.jwtIssuer,
    mocks.audit,
  );
}

beforeAll(() => {
  process.env['AUTH_COGNITO_DOMAIN'] = 'auth.example.com';
  process.env['AUTH_COGNITO_CLIENT_ID'] = 'cid';
  process.env['AUTH_COGNITO_REDIRECT_URI'] = 'https://x.example/cb';
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id_token: 'cognito.id.token' }),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  delete process.env['AUTH_COGNITO_DOMAIN'];
  delete process.env['AUTH_COGNITO_CLIENT_ID'];
  delete process.env['AUTH_COGNITO_REDIRECT_URI'];
});

describe('SessionOrchestratorService.handleCallback', () => {
  // Test 28: full success flow exercises Cognito exchange, ID-token verify,
  // resolveUser, single-tenant resolution, scope derivation, refresh-token
  // creation, JWT signing, audit emission. Verify call order + parameters.
  it('orchestrates the full /callback flow on the success path', async () => {
    const mocks = makeMocks();
    const svc = makeService(mocks);

    const result = await svc.handleCallback({
      consumer: 'recruiter',
      code: 'auth-code-123',
      state: 'state-1',
      cognitoError: undefined,
      cognitoErrorDescription: undefined,
      pkceStateCipher: 'cipher',
    });

    expect(result.kind).toBe('success');
    if (result.kind !== 'success') return;
    expect(result.accessJwt).toBe('signed.jwt.value');
    expect(typeof result.refreshTokenPlaintext).toBe('string');
    expect(result.refreshTokenPlaintext.length).toBeGreaterThan(0);

    expect(mocks.pkce.decryptState).toHaveBeenCalledWith('cipher');
    expect(mocks.cognito.verify).toHaveBeenCalledWith('cognito.id.token');
    expect(mocks.identity.resolveUser).toHaveBeenCalledWith({
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
    });
    expect(mocks.tenant.getTenantsByUser).toHaveBeenCalledWith({
      user_id: USER_ID,
    });
    expect(mocks.role.getScopesByUserAndTenant).toHaveBeenCalledWith({
      user_id: USER_ID,
      tenant_id: TENANT_ID,
    });
    expect(mocks.refreshTokens.create).toHaveBeenCalled();
    expect(mocks.jwtIssuer.sign).toHaveBeenCalled();
    expect(mocks.audit.writeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'identity.session.issued',
        actor_type: 'user',
        actor_id: USER_ID,
        tenant_id: TENANT_ID,
        subject_id: USER_ID,
      }),
    );
  });

  // Test 29: tenant_selection_required for >1 active membership.
  it('returns tenant_selection_required with tenants[] for multi-membership user', async () => {
    const mocks = makeMocks({
      tenant: {
        getTenantsByUser: vi.fn().mockResolvedValue([
          { id: TENANT_ID, name: 'Tenant One' },
          { id: TENANT_ID_2, name: 'Tenant Two' },
        ]),
      } as unknown as TenantService,
    });
    const svc = makeService(mocks);

    const result = await svc.handleCallback({
      consumer: 'recruiter',
      code: 'c',
      state: 'state-1',
      cognitoError: undefined,
      cognitoErrorDescription: undefined,
      pkceStateCipher: 'cipher',
    });

    expect(result.kind).toBe('tenant_selection_required');
    if (result.kind !== 'tenant_selection_required') return;
    expect(result.tenants).toHaveLength(2);
    expect(result.tenants[0]).toEqual({ id: TENANT_ID, name: 'Tenant One' });
  });

  // Test 30 (P4): 0 active memberships → auth_error no_active_tenant (4xx).
  it('returns auth_error with reason no_active_tenant when user has 0 memberships', async () => {
    const mocks = makeMocks({
      tenant: {
        getTenantsByUser: vi.fn().mockResolvedValue([]),
      } as unknown as TenantService,
    });
    const svc = makeService(mocks);
    const result = await svc.handleCallback({
      consumer: 'recruiter',
      code: 'c',
      state: 'state-1',
      cognitoError: undefined,
      cognitoErrorDescription: undefined,
      pkceStateCipher: 'cipher',
    });
    expect(result.kind).toBe('auth_error');
    if (result.kind !== 'auth_error') return;
    expect(result.reason).toBe('no_active_tenant');
  });

  // Test 31 (P4 + R3): resolveUser null AND no email match → auth_error
  // user_not_provisioned (4xx), and NOTHING is created (no open JIT).
  it('returns auth_error user_not_provisioned when resolveUser null and no seeded email matches; creates nothing', async () => {
    const mocks = makeMocks({
      identity: {
        resolveUser: vi.fn().mockResolvedValue(null),
        findUserByEmail: vi.fn().mockResolvedValue(null),
        linkExternalIdentity: vi.fn(),
      } as unknown as IdentityService,
    });
    const svc = makeService(mocks);
    const result = await svc.handleCallback({
      consumer: 'recruiter',
      code: 'c',
      state: 'state-1',
      cognitoError: undefined,
      cognitoErrorDescription: undefined,
      pkceStateCipher: 'cipher',
    });
    expect(result.kind).toBe('auth_error');
    if (result.kind !== 'auth_error') return;
    expect(result.reason).toBe('user_not_provisioned');
    // No open JIT: nothing linked, no token minted.
    expect(mocks.identity.linkExternalIdentity).not.toHaveBeenCalled();
    expect(mocks.jwtIssuer.sign).not.toHaveBeenCalled();
  });

  // R3: first login (sub unknown) → reconcile by verified email to the
  // seeded identity → LINK the federated sub → proceed to success. The
  // email is matched normalized-exact (lowercase + trim).
  it('R3 — reconciles by verified email and links the federated sub when resolveUser misses', async () => {
    const SEEDED_ID = '01900000-0000-7000-8000-0000000000ff';
    const linkExternalIdentity = vi.fn().mockResolvedValue({
      id: 'ext-new',
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
      user_id: SEEDED_ID,
      email_snapshot: 'Owner@Aramo.AI',
      created_at: '',
      updated_at: '',
    });
    const findUserByEmail = vi.fn().mockResolvedValue({
      id: SEEDED_ID,
      email: 'owner@aramo.ai',
      display_name: 'Aramo Platform Owner',
      is_active: true,
      deactivated_at: null,
      created_at: '',
      updated_at: '',
    });
    const mocks = makeMocks({
      cognito: {
        verify: vi.fn().mockResolvedValue({
          sub: COGNITO_SUB,
          email: '  Owner@Aramo.AI ', // mixed case + whitespace
          email_verified: true,
          token_use: 'id',
        }),
      } as unknown as CognitoVerifierService,
      identity: {
        resolveUser: vi.fn().mockResolvedValue(null),
        findUserByEmail,
        linkExternalIdentity,
      } as unknown as IdentityService,
    });
    const svc = makeService(mocks);

    const result = await svc.handleCallback({
      consumer: 'recruiter',
      code: 'c',
      state: 'state-1',
      cognitoError: undefined,
      cognitoErrorDescription: undefined,
      pkceStateCipher: 'cipher',
    });

    expect(result.kind).toBe('success');
    // Normalized-exact: lowercased + trimmed before lookup.
    expect(findUserByEmail).toHaveBeenCalledWith('owner@aramo.ai');
    // The federated sub is linked to the seeded user.
    expect(linkExternalIdentity).toHaveBeenCalledWith({
      user_id: SEEDED_ID,
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
      email_snapshot: '  Owner@Aramo.AI ',
    });
    // The canonical sub-link audit event is emitted (global).
    expect(mocks.audit.writeGlobalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'identity.external_identity.linked',
        actor_id: SEEDED_ID,
        subject_id: SEEDED_ID,
      }),
    );
  });

  // P4: a token-content rejection from the verifier (typed error) maps to
  // auth_error (4xx), NOT internal_error (500). A non-typed verifier failure
  // (JWKS/network) stays internal_error.
  it('P4 — verifier CognitoVerificationError maps to auth_error; plain Error stays internal_error', async () => {
    const { CognitoVerificationError } = await import(
      '../app/auth/cognito-verifier.service.js'
    );
    const authMocks = makeMocks({
      cognito: {
        verify: vi
          .fn()
          .mockRejectedValue(new CognitoVerificationError('email_not_verified')),
      } as unknown as CognitoVerifierService,
    });
    const authResult = await makeService(authMocks).handleCallback({
      consumer: 'recruiter',
      code: 'c',
      state: 'state-1',
      cognitoError: undefined,
      cognitoErrorDescription: undefined,
      pkceStateCipher: 'cipher',
    });
    expect(authResult.kind).toBe('auth_error');
    if (authResult.kind === 'auth_error') {
      expect(authResult.reason).toBe('email_not_verified');
    }

    const serverMocks = makeMocks({
      cognito: {
        verify: vi.fn().mockRejectedValue(new Error('jwks fetch failed')),
      } as unknown as CognitoVerifierService,
    });
    const serverResult = await makeService(serverMocks).handleCallback({
      consumer: 'recruiter',
      code: 'c',
      state: 'state-1',
      cognitoError: undefined,
      cognitoErrorDescription: undefined,
      pkceStateCipher: 'cipher',
    });
    expect(serverResult.kind).toBe('internal_error');
    if (serverResult.kind === 'internal_error') {
      expect(serverResult.reason).toBe('cognito_verification_failed');
    }
  });

  it('returns validation_error when state mismatches between query and decrypted cookie', async () => {
    const mocks = makeMocks();
    const svc = makeService(mocks);
    const result = await svc.handleCallback({
      consumer: 'recruiter',
      code: 'c',
      state: 'a-different-state',
      cognitoError: undefined,
      cognitoErrorDescription: undefined,
      pkceStateCipher: 'cipher',
    });
    expect(result.kind).toBe('validation_error');
    if (result.kind !== 'validation_error') return;
    expect(result.reason).toBe('state_mismatch');
  });

  it('returns validation_error when consumer in cookie does not match path consumer', async () => {
    const mocks = makeMocks();
    (mocks.pkce.decryptState as ReturnType<typeof vi.fn>).mockReturnValue({
      verifier: 'v',
      state: 'state-1',
      consumer: 'portal',
      issued_at: Math.floor(Date.now() / 1000),
    });
    const svc = makeService(mocks);
    const result = await svc.handleCallback({
      consumer: 'recruiter',
      code: 'c',
      state: 'state-1',
      cognitoError: undefined,
      cognitoErrorDescription: undefined,
      pkceStateCipher: 'cipher',
    });
    expect(result.kind).toBe('validation_error');
    if (result.kind !== 'validation_error') return;
    expect(result.reason).toBe('consumer_mismatch');
  });

  // PR-A1a-3 Ruling 1 (auto-stamp): site-scoped membership.
  // findActiveMembershipSite returns a real site_id → orchestrator
  // resolves scopes via site-aware resolver AND stamps site_id on JWT.
  it('PR-A1a-3 Ruling 1 — auto-stamps site_id when membership is site-scoped', async () => {
    const SITE_ID = '01900000-0000-7000-8000-0000000000c1';
    const mocks = makeMocks();
    (mocks.role.findActiveMembershipSite as ReturnType<typeof vi.fn>)
      .mockResolvedValue(SITE_ID);
    (mocks.role.getScopesByUserTenantAndSite as ReturnType<typeof vi.fn>)
      .mockResolvedValue(['talent:read']);
    const svc = makeService(mocks);

    const result = await svc.handleCallback({
      consumer: 'recruiter',
      code: 'c',
      state: 'state-1',
      cognitoError: undefined,
      cognitoErrorDescription: undefined,
      pkceStateCipher: 'cipher',
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
    // Tenant-wide resolver NOT called when site is stamped.
    expect(mocks.role.getScopesByUserAndTenant).not.toHaveBeenCalled();
    // Issuer receives the site_id claim.
    expect(mocks.jwtIssuer.sign).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: USER_ID,
        tenant_id: TENANT_ID,
        site_id: SITE_ID,
        scopes: ['talent:read'],
      }),
    );
  });

  // PR-A1a-3 Ruling 2 (tenant-wide byte-shape): tenant-wide membership.
  // findActiveMembershipSite returns null → orchestrator takes EXISTING
  // path (getScopesByUserAndTenant) AND does NOT stamp site_id. The
  // call to jwtIssuer.sign must NOT carry a site_id key.
  it('PR-A1a-3 Ruling 2 — does NOT stamp site_id when membership is tenant-wide (byte-shape preserved)', async () => {
    const mocks = makeMocks(); // findActiveMembershipSite defaults to null.
    const svc = makeService(mocks);

    const result = await svc.handleCallback({
      consumer: 'recruiter',
      code: 'c',
      state: 'state-1',
      cognitoError: undefined,
      cognitoErrorDescription: undefined,
      pkceStateCipher: 'cipher',
    });

    expect(result.kind).toBe('success');
    // Existing tenant-wide path is taken; site-aware resolver NOT called.
    expect(mocks.role.getScopesByUserAndTenant).toHaveBeenCalledWith({
      user_id: USER_ID,
      tenant_id: TENANT_ID,
    });
    expect(mocks.role.getScopesByUserTenantAndSite).not.toHaveBeenCalled();
    // Issuer payload must NOT include site_id (byte-shape parity).
    const signCall = (mocks.jwtIssuer.sign as ReturnType<typeof vi.fn>).mock.calls[0]![0]!;
    expect('site_id' in signCall).toBe(false);
  });
});
