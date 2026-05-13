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
      getScopesByUserAndTenant: vi
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

  // Test 30: 0 active memberships → INTERNAL_ERROR no_active_tenant.
  it('returns internal_error with reason no_active_tenant when user has 0 memberships', async () => {
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
    expect(result.kind).toBe('internal_error');
    if (result.kind !== 'internal_error') return;
    expect(result.reason).toBe('no_active_tenant');
  });

  // Test 31: resolveUser returns null → INTERNAL_ERROR user_not_provisioned.
  it('returns internal_error with reason user_not_provisioned when resolveUser returns null', async () => {
    const mocks = makeMocks({
      identity: {
        resolveUser: vi.fn().mockResolvedValue(null),
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
    expect(result.kind).toBe('internal_error');
    if (result.kind !== 'internal_error') return;
    expect(result.reason).toBe('user_not_provisioned');
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
});
