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
      // §5 D2 reconcile deps — default success path resolves by sub, so these
      // are not reached unless a test nulls resolveUser.
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
      // Invite-S2 — the reconcile-spine ACTIVE-hook. Reached ONLY on the
      // by-sub MISS branch (right after linkExternalIdentity), never on the
      // by-sub HIT default-success path.
      activateMembershipsOnLink: vi.fn().mockResolvedValue({ activated: 0 }),
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

  // Test 30: 0 active memberships → §5 D2 P4 AUTH_ERROR no_active_tenant
  // (was internal_error/500; now a clean 4xx auth_error).
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

  // Test 31: resolveUser miss AND no email match → §5 D2 P4 AUTH_ERROR
  // user_not_provisioned. The reconcile ran (findUserByEmail) but found no
  // seeded identity → clean 403, no link created.
  it('returns auth_error user_not_provisioned when resolveUser misses and no email match', async () => {
    const linkSpy = vi.fn();
    const mocks = makeMocks({
      identity: {
        resolveUser: vi.fn().mockResolvedValue(null),
        findUserByEmail: vi.fn().mockResolvedValue(null),
        linkExternalIdentity: linkSpy,
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
    // No reconcile link is created when the email does not match.
    expect(linkSpy).not.toHaveBeenCalled();
  });

  // §5 D2: resolveUser miss + verified-email match → reconcile links the
  // federated sub to the existing user (normalized-exact email), emits the
  // global audit event, and proceeds to a session.
  it('reconciles by verified email on resolveUser miss: links sub to existing user, emits audit, succeeds', async () => {
    const linkSpy = vi.fn().mockResolvedValue({
      id: 'ext-1',
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
      user_id: USER_ID,
      email_snapshot: 'A@B.c',
      created_at: '',
      updated_at: '',
    });
    const existing = {
      id: USER_ID,
      email: 'a@b.c',
      display_name: null,
      is_active: true,
      deactivated_at: null,
      created_at: '',
      updated_at: '',
    };
    const mocks = makeMocks({
      cognito: {
        verify: vi.fn().mockResolvedValue({
          sub: COGNITO_SUB,
          email: 'A@B.c', // mixed-case → reconcile normalizes to a@b.c
          email_verified: true,
          token_use: 'id',
        }),
      } as unknown as CognitoVerifierService,
      identity: {
        resolveUser: vi.fn().mockResolvedValue(null), // by-sub MISS
        findUserByEmail: vi.fn().mockResolvedValue(existing),
        linkExternalIdentity: linkSpy,
        activateMembershipsOnLink: vi
          .fn()
          .mockResolvedValue({ activated: 1 }),
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
    // Email matched normalized-exact (lowercased + trimmed).
    expect(mocks.identity.findUserByEmail).toHaveBeenCalledWith('a@b.c');
    // Invite-S2 — the ACTIVE-hook fired exactly once on this first-login
    // reconcile, for the just-linked user (INVITED/ACCEPTED → ACTIVE).
    expect(mocks.identity.activateMembershipsOnLink).toHaveBeenCalledTimes(1);
    expect(mocks.identity.activateMembershipsOnLink).toHaveBeenCalledWith({
      user_id: USER_ID,
    });
    // The link wires to the existing user with the federated sub.
    expect(linkSpy).toHaveBeenCalledWith({
      user_id: USER_ID,
      provider: 'cognito',
      provider_subject: COGNITO_SUB,
      email_snapshot: 'A@B.c',
    });
    // Canonical global audit event for the sub-link.
    expect(mocks.audit.writeGlobalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'identity.external_identity.linked',
        actor_id: USER_ID,
        subject_id: USER_ID,
        payload: expect.objectContaining({ reason: 'reconcile_by_verified_email' }),
      }),
    );
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

// =============================================================================
// Invite-S2 (Pattern-2) — the reconcile-spine ACTIVE-hook SAFETY GUARD (§8.8).
//
// THE NON-NEGOTIABLE REGRESSION GUARD: an already-ACTIVE user's login is the
// proven path. The ACTIVE-hook (activateMembershipsOnLink) lives INSIDE the
// by-sub-MISS branch, structurally unreachable for an already-active user
// whose login resolves by-sub HIT. This proves the by-sub-HIT path is
// BYTE-UNCHANGED: no membership state write, no reconcile link, no extra audit
// — the hook never fires.
// =============================================================================
describe('SessionOrchestratorService — Invite-S2 ACTIVE-hook safety (by-sub HIT path byte-unchanged)', () => {
  it('already-ACTIVE user (by-sub HIT) → ACTIVE-hook NEVER fires; no reconcile link; no extra writes', async () => {
    // The default mock resolves the user by sub (HIT) — the existing-user
    // login path. This is the path the whole product runs on today.
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

    // THE LOAD-BEARING GUARD: the ACTIVE-hook did NOT fire on the by-sub HIT
    // path. An already-active user's membership state is never touched.
    expect(mocks.identity.activateMembershipsOnLink).not.toHaveBeenCalled();

    // And the rest of the reconcile machinery stayed dormant too — proving
    // the path is byte-identical to pre-S2:
    //   - no reconcile-by-email lookup,
    //   - no sub re-link,
    //   - no external_identity.linked audit (only the normal session.issued).
    expect(mocks.identity.findUserByEmail).not.toHaveBeenCalled();
    expect(mocks.identity.linkExternalIdentity).not.toHaveBeenCalled();
    expect(mocks.audit.writeGlobalEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'identity.external_identity.linked',
      }),
    );
  });

  it('first-login reconcile (by-sub MISS + email match) → ACTIVE-hook fires exactly once for the linked user', async () => {
    // The complement: on the by-sub MISS branch the hook DOES fire — exactly
    // once, after the sub-link, for the just-matched user. (The success-path
    // detail is already covered by the reconcile test above; here we isolate
    // the hook's once-only firing + ordering relative to the link.)
    const existing = {
      id: USER_ID,
      email: 'a@b.c',
      display_name: null,
      is_active: true,
      deactivated_at: null,
      created_at: '',
      updated_at: '',
    };
    const order: string[] = [];
    const linkSpy = vi.fn().mockImplementation(async () => {
      order.push('link');
      return {
        id: 'ext-1',
        provider: 'cognito',
        provider_subject: COGNITO_SUB,
        user_id: USER_ID,
        email_snapshot: 'a@b.c',
        created_at: '',
        updated_at: '',
      };
    });
    const activateSpy = vi.fn().mockImplementation(async () => {
      order.push('activate');
      return { activated: 1 };
    });
    const mocks = makeMocks({
      identity: {
        resolveUser: vi.fn().mockResolvedValue(null), // by-sub MISS
        findUserByEmail: vi.fn().mockResolvedValue(existing),
        linkExternalIdentity: linkSpy,
        activateMembershipsOnLink: activateSpy,
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
    expect(activateSpy).toHaveBeenCalledTimes(1);
    expect(activateSpy).toHaveBeenCalledWith({ user_id: USER_ID });
    // The hook fires AFTER the sub-link (ACTIVE follows the link, never before).
    expect(order).toEqual(['link', 'activate']);
  });
});
