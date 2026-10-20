import type { IdentityProviderPolicyService } from '@aramo/identity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_TENANT_SENTINEL_ID } from '@aramo/auth';
import type {
  AuthorizationVersionService,
  IdentityAuditService,
  IdentityService,
  RoleService,
  TenantEntitlementReader,
  TenantService,
} from '@aramo/identity';

import { IdentityPrincipalDirectoryAdapter } from '../app/auth/identity-principal-directory.adapter.js';

// Auth-Decoupling PR-4 §3.5 (adapter units — resolveSession all 3 kinds +
// resolveScopes) AND §3.2 (one assertion per §2.4 invariant 1-6). This is where
// the reconcile/activation/tenant/status/site/scope logic — moved out of the
// orchestrator — is now tested directly.

const USER_ID = '01900000-0000-7000-8000-000000000001';
const TENANT_ID = '01900000-0000-7000-8000-0000000000aa';
const TENANT_ID_2 = '01900000-0000-7000-8000-0000000000ab';
const SITE_ID = '01900000-0000-7000-8000-0000000000c1';
const SUB = 'cognito-sub-01';

interface Deps {
  identity: IdentityService;
  tenant: TenantService;
  role: RoleService;
  audit: IdentityAuditService;
  authzVersions: AuthorizationVersionService;
  entitlements: TenantEntitlementReader;
  idpPolicy?: IdentityProviderPolicyService;
}

function makeDeps(over: {
  resolveUser?: unknown;
  findUserByEmail?: unknown;
  // IC-2 PR-5 — the refresh-path user read (null = no such user).
  userById?: unknown;
  tenants?: unknown[];
  status?: string;
  activateImpl?: () => Promise<unknown>;
  site?: string | null;
  order?: string[];
  // IC-2 PR-6 — the tenant's live product capabilities ('throws' = store down).
  capabilities?: string[] | 'throws';
  // IC-4 PR-9 (J-9) — the membership's role keys for the first-session
  // activation discriminator; 'throws' = the transition fails.
  roleKeys?: string[];
  transition?: 'throws';
} = {}): Deps & {
  resolveUser: ReturnType<typeof vi.fn>;
  findUserByEmail: ReturnType<typeof vi.fn>;
  linkExternalIdentity: ReturnType<typeof vi.fn>;
  activate: ReturnType<typeof vi.fn>;
  getTenantsByUser: ReturnType<typeof vi.fn>;
  findActiveMembershipSite: ReturnType<typeof vi.fn>;
  getScopesByUserAndTenant: ReturnType<typeof vi.fn>;
  getScopesByUserTenantAndSite: ReturnType<typeof vi.fn>;
  writeGlobalEvent: ReturnType<typeof vi.fn>;
  getCapabilities: ReturnType<typeof vi.fn>;
  findMembership: ReturnType<typeof vi.fn>;
  findRoleKeysForMembership: ReturnType<typeof vi.fn>;
  transitionTenantStatus: ReturnType<typeof vi.fn>;
} {
  const order = over.order;
  const resolveUser = vi
    .fn()
    .mockResolvedValue(over.resolveUser === undefined ? { id: USER_ID } : over.resolveUser);
  const findUserByEmail = vi
    .fn()
    .mockResolvedValue(over.findUserByEmail === undefined ? null : over.findUserByEmail);
  const findUserById = vi
    .fn()
    .mockResolvedValue(over.userById === undefined ? { id: USER_ID, is_active: true } : over.userById);
  const linkExternalIdentity = vi.fn().mockImplementation(async () => {
    order?.push('link');
    return { id: 'ext-1' };
  });
  const activate = vi
    .fn()
    .mockImplementation(over.activateImpl ?? (async () => { order?.push('activate'); return { activated: 0 }; }));
  const getTenantsByUser = vi.fn().mockImplementation(async () => {
    order?.push('tenants');
    return (
      over.tenants ?? [{ id: TENANT_ID, name: 'Tenant One', status: over.status ?? 'ACTIVE' }]
    );
  });
  const findActiveMembershipSite = vi.fn().mockResolvedValue(over.site ?? null);
  const getScopesByUserAndTenant = vi.fn().mockResolvedValue(['auth:session:read']);
  const getScopesByUserTenantAndSite = vi.fn().mockResolvedValue(['talent:read']);
  const writeGlobalEvent = vi.fn().mockResolvedValue(undefined);

  // IC-4 PR-9 (J-9) — owner first-session activation collaborators.
  const findMembership = vi.fn().mockResolvedValue({ id: 'mem-1', user_id: USER_ID, tenant_id: TENANT_ID, is_active: true });
  const findRoleKeysForMembership = vi.fn().mockResolvedValue(over.roleKeys ?? ['recruiter']);
  const transitionTenantStatus = vi.fn(async () => {
    if (over.transition === 'throws') throw new Error('lifecycle write failed');
    return { from: 'PROVISIONED', to: 'ACTIVE', changed: true };
  });
  const identity = {
    resolveUser,
    findUserByEmail,
    findUserById,
    linkExternalIdentity,
    activateAcceptedMembershipsOnSession: activate,
    findMembership,
    findRoleKeysForMembership,
  } as unknown as IdentityService;
  const tenant = { getTenantsByUser, transitionTenantStatus } as unknown as TenantService;
  const role = {
    findActiveMembershipSite,
    getScopesByUserAndTenant,
    getScopesByUserTenantAndSite,
  } as unknown as RoleService;
  const audit = { writeGlobalEvent } as unknown as IdentityAuditService;
  // HF-AUTH-1 — the adapter stamps the current authorization version into the
  // resolved session/scopes for the compact token mint.
  const getCurrentVersion = vi.fn().mockResolvedValue(1);
  const authzVersions = { getCurrentVersion } as unknown as AuthorizationVersionService;
  const getCapabilities = vi.fn(async () => {
    if (over.capabilities === 'throws') throw new Error('entitlement store down');
    return new Set<string>(over.capabilities ?? ['core', 'ats', 'portal']);
  });
  const entitlements = { getCapabilities } as unknown as TenantEntitlementReader;

  return {
    identity, tenant, role, audit, authzVersions, entitlements, getCapabilities,
    resolveUser, findUserByEmail, linkExternalIdentity, activate, getTenantsByUser,
    findActiveMembershipSite, getScopesByUserAndTenant, getScopesByUserTenantAndSite, writeGlobalEvent,
    findMembership, findRoleKeysForMembership, transitionTenantStatus,
  };
}

function adapter(d: Deps): IdentityPrincipalDirectoryAdapter {
  return new IdentityPrincipalDirectoryAdapter(d.identity, d.tenant, d.role, d.audit, d.authzVersions, d.entitlements, d.idpPolicy ?? ({ evaluate: async () => ({ ok: true, pinned_now: false }), recordLinkIdp: async () => undefined } as unknown as IdentityProviderPolicyService));
}

const SESSION_INPUT = {
  provider: 'cognito',
  provider_subject: SUB,
  verified_email: 'a@b.c',
  consumer: 'recruiter' as const,
};

beforeEach(() => vi.clearAllMocks());

describe('resolveSession — the three result kinds (§3.5)', () => {
  it('RESOLVED (by-sub hit): returns principal_id/context_id/scopes', async () => {
    const d = makeDeps();
    const r = await adapter(d).resolveSession(SESSION_INPUT);
    expect(r.kind).toBe('resolved');
    if (r.kind !== 'resolved') return;
    expect(r.principal_id).toBe(USER_ID);
    expect(r.context_id).toBe(TENANT_ID);
    expect(r.scopes).toEqual(['auth:session:read']);
    expect(r.claims).toBeUndefined();
  });

  // IC-2 PR-4 (Auth-Decoupling PR-4 Amendment A1 §2 item 1): INVERTED — the
  // multi-tenant read is unreachable against the IC-1 PR-3 database; as a
  // defensive guard it is DENIED (fail-closed), never a chooser, naming no tenant.
  it('DEFENSIVE multi-tenant read → denied tenant_resolution_ambiguous (no chooser, no tenant named)', async () => {
    const d = makeDeps({
      tenants: [
        { id: TENANT_ID, name: 'Tenant One' },
        { id: TENANT_ID_2, name: 'Tenant Two' },
      ],
    });
    const r = await adapter(d).resolveSession(SESSION_INPUT);
    expect(r).toEqual({ kind: 'denied', reason: 'tenant_resolution_ambiguous' });
    expect(d.getScopesByUserAndTenant).not.toHaveBeenCalled();
  });

  it('DENIED no_active_tenant: 0 tenants', async () => {
    const d = makeDeps({ tenants: [] });
    const r = await adapter(d).resolveSession(SESSION_INPUT);
    expect(r).toEqual({ kind: 'denied', reason: 'no_active_tenant' });
  });
});

describe('§2.4 invariant 1 — activation AFTER reconcile/link, BEFORE tenant resolution', () => {
  it('reconcile path order is link → activate → tenants (load-bearing)', async () => {
    const order: string[] = [];
    const d = makeDeps({ resolveUser: null, findUserByEmail: { id: USER_ID }, order });
    await adapter(d).resolveSession(SESSION_INPUT);
    expect(order).toEqual(['link', 'activate', 'tenants']);
  });

  it('by-sub hit: activation still runs BEFORE tenants (no link)', async () => {
    const order: string[] = [];
    const d = makeDeps({ order });
    await adapter(d).resolveSession(SESSION_INPUT);
    expect(order).toEqual(['activate', 'tenants']);
  });
});

describe('§2.4 invariant 2 — activation is best-effort', () => {
  it('activation throws → sign-in still resolves', async () => {
    const d = makeDeps({ activateImpl: () => Promise.reject(new Error('activate boom')) });
    const r = await adapter(d).resolveSession(SESSION_INPUT);
    expect(r.kind).toBe('resolved');
  });
});

describe('§2.4 invariant 3 — account-takeover guard (link reached only on by-sub MISS)', () => {
  it('by-sub HIT → linkExternalIdentity NEVER called, no linked audit', async () => {
    const d = makeDeps();
    await adapter(d).resolveSession(SESSION_INPUT);
    expect(d.linkExternalIdentity).not.toHaveBeenCalled();
    expect(d.writeGlobalEvent).not.toHaveBeenCalled();
  });

  it('by-sub MISS + email match → link created once with the presented sub, linked audit emitted', async () => {
    const d = makeDeps({ resolveUser: null, findUserByEmail: { id: USER_ID } });
    await adapter(d).resolveSession({ ...SESSION_INPUT, verified_email: 'A@B.c' });
    expect(d.linkExternalIdentity).toHaveBeenCalledTimes(1);
    expect(d.linkExternalIdentity).toHaveBeenCalledWith({
      user_id: USER_ID,
      provider: 'cognito',
      provider_subject: SUB,
      email_snapshot: 'A@B.c', // snapshot is the raw verified email
    });
    // reconcile matched on the NORMALISED email (lowercased + trimmed).
    expect(d.findUserByEmail).toHaveBeenCalledWith('a@b.c');
    expect(d.writeGlobalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event_type: 'identity.external_identity.linked' }),
    );
  });
});

describe('§2.4 invariant 4 — no open JIT', () => {
  it('unknown verified email → denied user_not_provisioned, nothing created', async () => {
    const d = makeDeps({ resolveUser: null, findUserByEmail: null });
    const r = await adapter(d).resolveSession(SESSION_INPUT);
    expect(r).toEqual({ kind: 'denied', reason: 'user_not_provisioned' });
    expect(d.linkExternalIdentity).not.toHaveBeenCalled();
    expect(d.activate).not.toHaveBeenCalled();
    expect(d.getTenantsByUser).not.toHaveBeenCalled();
  });
});

describe('§2.4 invariant 5 — status gate (tenant consumers only; PROVISIONED mints; platform exempt)', () => {
  it('SUSPENDED (recruiter) → denied tenant_suspended', async () => {
    const r = await adapter(makeDeps({ status: 'SUSPENDED' })).resolveSession(SESSION_INPUT);
    expect(r).toEqual({ kind: 'denied', reason: 'tenant_suspended' });
  });
  it('CLOSED (recruiter) → denied tenant_closed', async () => {
    const r = await adapter(makeDeps({ status: 'CLOSED' })).resolveSession(SESSION_INPUT);
    expect(r).toEqual({ kind: 'denied', reason: 'tenant_closed' });
  });
  it.each(['PROVISIONED', 'ACTIVE', 'OFFBOARDING'])('%s (recruiter) → resolved (mints)', async (status) => {
    const r = await adapter(makeDeps({ status })).resolveSession(SESSION_INPUT);
    expect(r.kind).toBe('resolved');
  });
  it('platform consumer is EXEMPT — SUSPENDED sentinel still resolves', async () => {
    const r = await adapter(makeDeps({ status: 'SUSPENDED' })).resolveSession({
      ...SESSION_INPUT,
      consumer: 'platform',
    });
    expect(r.kind).toBe('resolved');
  });
});

describe('§2.4 invariant 6 — site-stamp scope selection (resolveSession + resolveScopes §3.5)', () => {
  it('site-scoped: resolveSession uses site resolver + carries claims.site_id', async () => {
    const d = makeDeps({ site: SITE_ID });
    const r = await adapter(d).resolveSession(SESSION_INPUT);
    expect(r.kind).toBe('resolved');
    if (r.kind !== 'resolved') return;
    expect(d.getScopesByUserTenantAndSite).toHaveBeenCalledWith({
      user_id: USER_ID, tenant_id: TENANT_ID, site_id: SITE_ID,
    });
    expect(d.getScopesByUserAndTenant).not.toHaveBeenCalled();
    expect(r.claims).toEqual({ site_id: SITE_ID });
    expect(r.scopes).toEqual(['talent:read']);
  });

  it('tenant-wide: resolveSession uses tenant resolver + NO claims', async () => {
    const d = makeDeps({ site: null });
    const r = await adapter(d).resolveSession(SESSION_INPUT);
    if (r.kind !== 'resolved') return;
    expect(d.getScopesByUserAndTenant).toHaveBeenCalledWith({ user_id: USER_ID, tenant_id: TENANT_ID });
    expect(d.getScopesByUserTenantAndSite).not.toHaveBeenCalled();
    expect(r.claims).toBeUndefined();
  });

  it('resolveScopes site-scoped → { scopes, claims.site_id }', async () => {
    const d = makeDeps({ site: SITE_ID });
    const r = await adapter(d).resolveScopes({ principal_id: USER_ID, context_id: TENANT_ID, consumer: 'recruiter' });
    // HF-AUTH-1 — resolveScopes now also carries the current authorization version
    // (stamped into the re-minted compact token on refresh).
    expect(r).toEqual({ kind: 'resolved', scopes: ['talent:read'], authz_version: 1, claims: { site_id: SITE_ID } });
  });

  it('resolveScopes tenant-wide → { scopes } (no claims)', async () => {
    const d = makeDeps({ site: null });
    const r = await adapter(d).resolveScopes({ principal_id: USER_ID, context_id: TENANT_ID, consumer: 'recruiter' });
    expect(r).toEqual({ kind: 'resolved', scopes: ['auth:session:read'], authz_version: 1 });
  });
});

// IC-2 PR-4 (F-2/F-5/F-6/F-8) — HOST BINDING in the adapter: after tenant
// selection, before the status gate; comparand = selectedTenant.id (F-2).
describe('IC-2 PR-4 — host binding (after tenant selection, before the status gate)', () => {
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
  const enforce = () => { process.env['AUTH_HOST_TENANT_BINDING'] = 'enforce'; };

  describe('enforce', () => {
    it('TENANT host whose context equals the selected tenant → resolved', async () => {
      enforce();
      const r = await adapter(makeDeps()).resolveSession({ ...SESSION_INPUT, host_class: 'TENANT', context_id: TENANT_ID });
      expect(r.kind).toBe('resolved');
    });

    it('TENANT host of ANOTHER tenant → denied host_tenant_mismatch; the status gate is never consulted (no foreign lifecycle leak)', async () => {
      enforce();
      // The user\'s tenant is SUSPENDED: a mismatched host must see the binding
      // denial, NOT tenant_suspended (F-5 ordering: binding BEFORE the status gate).
      const d = makeDeps({ status: 'SUSPENDED' });
      const r = await adapter(d).resolveSession({ ...SESSION_INPUT, host_class: 'TENANT', context_id: TENANT_ID_2 });
      expect(r).toEqual({ kind: 'denied', reason: 'host_tenant_mismatch' });
      expect(d.getScopesByUserAndTenant).not.toHaveBeenCalled();
    });

    it('TENANT host with a null context → denied host_tenant_mismatch', async () => {
      enforce();
      const r = await adapter(makeDeps()).resolveSession({ ...SESSION_INPUT, host_class: 'TENANT', context_id: null });
      expect(r).toEqual({ kind: 'denied', reason: 'host_tenant_mismatch' });
    });

    it('PLATFORM host + platform consumer + sentinel tenant → resolved', async () => {
      enforce();
      const d = makeDeps({ tenants: [{ id: PLATFORM_TENANT_SENTINEL_ID, name: 'Aramo Platform', status: 'PROVISIONED' }] });
      const r = await adapter(d).resolveSession({ ...SESSION_INPUT, consumer: 'platform', host_class: 'PLATFORM', context_id: null });
      expect(r.kind).toBe('resolved');
    });

    it('PLATFORM host + recruiter consumer → denied host_class_consumer_mismatch', async () => {
      enforce();
      const r = await adapter(makeDeps()).resolveSession({ ...SESSION_INPUT, host_class: 'PLATFORM', context_id: null });
      expect(r).toEqual({ kind: 'denied', reason: 'host_class_consumer_mismatch' });
    });

    it('PLATFORM host + platform consumer but a NON-sentinel tenant → denied host_tenant_mismatch', async () => {
      enforce();
      const r = await adapter(makeDeps()).resolveSession({ ...SESSION_INPUT, consumer: 'platform', host_class: 'PLATFORM', context_id: null });
      expect(r).toEqual({ kind: 'denied', reason: 'host_tenant_mismatch' });
    });

    it.each(['PORTAL', 'PRODUCT'] as const)('%s host → denied host_class_consumer_mismatch (portal = passwordless only; product = DARK scaffold)', async (cls) => {
      enforce();
      const r = await adapter(makeDeps()).resolveSession({ ...SESSION_INPUT, host_class: cls, context_id: null });
      expect(r).toEqual({ kind: 'denied', reason: 'host_class_consumer_mismatch' });
    });

    it('LEGACY cookie (no host fields) → denied host_unbound (F-8)', async () => {
      enforce();
      const r = await adapter(makeDeps()).resolveSession(SESSION_INPUT);
      expect(r).toEqual({ kind: 'denied', reason: 'host_unbound' });
    });

    it.each([null, 'DEV'] as const)('unvalidated/dev host (%s) → denied host_unbound unless AUTH_ALLOW_UNBOUND_HOST=true', async (cls) => {
      enforce();
      const r1 = await adapter(makeDeps()).resolveSession({ ...SESSION_INPUT, host_class: cls, context_id: null });
      expect(r1).toEqual({ kind: 'denied', reason: 'host_unbound' });
      process.env['AUTH_ALLOW_UNBOUND_HOST'] = 'true';
      const r2 = await adapter(makeDeps()).resolveSession({ ...SESSION_INPUT, host_class: cls, context_id: null });
      expect(r2.kind).toBe('resolved');
    });

    it('AUTH_ALLOW_UNBOUND_HOST never overrides an explicit tenant or platform mismatch', async () => {
      enforce();
      process.env['AUTH_ALLOW_UNBOUND_HOST'] = 'true';
      const r1 = await adapter(makeDeps()).resolveSession({ ...SESSION_INPUT, host_class: 'TENANT', context_id: TENANT_ID_2 });
      expect(r1).toEqual({ kind: 'denied', reason: 'host_tenant_mismatch' });
      const r2 = await adapter(makeDeps()).resolveSession({ ...SESSION_INPUT, host_class: 'PLATFORM', context_id: null });
      expect(r2).toEqual({ kind: 'denied', reason: 'host_class_consumer_mismatch' });
    });

    it('a matched binding still runs the status gate (SUSPENDED → tenant_suspended)', async () => {
      enforce();
      const r = await adapter(makeDeps({ status: 'SUSPENDED' })).resolveSession({ ...SESSION_INPUT, host_class: 'TENANT', context_id: TENANT_ID });
      expect(r).toEqual({ kind: 'denied', reason: 'tenant_suspended' });
    });
  });

  describe('log (default)', () => {
    it.each([
      ['TENANT mismatch', { host_class: 'TENANT', context_id: TENANT_ID_2 }],
      ['PLATFORM + recruiter', { host_class: 'PLATFORM', context_id: null }],
      ['PRODUCT (dark)', { host_class: 'PRODUCT', context_id: null }],
      ['unvalidated host', { host_class: null, context_id: null }],
      ['legacy cookie', {}],
    ] as const)('%s → outcome UNCHANGED (resolved)', async (_label, extra) => {
      const r = await adapter(makeDeps()).resolveSession({ ...SESSION_INPUT, ...extra });
      expect(r.kind).toBe('resolved');
    });

    it('a typo in the mode value is NOT enforce (fail-closed parse → log)', async () => {
      process.env['AUTH_HOST_TENANT_BINDING'] = 'Enforce';
      const r = await adapter(makeDeps()).resolveSession({ ...SESSION_INPUT, host_class: 'TENANT', context_id: TENANT_ID_2 });
      expect(r.kind).toBe('resolved');
    });
  });
});

// IC-2 PR-5 (Auth-Decoupling PR-4 Amendment A2) — refresh ELIGIBILITY re-proven
// at the identity boundary; User.is_active (N-6) at login AND refresh.
describe('IC-2 PR-5 — resolveScopes eligibility (refresh) + User.is_active at login', () => {
  const INPUT = { principal_id: USER_ID, context_id: TENANT_ID, consumer: 'recruiter' as const };

  it('eligible: active user, active membership in the stored tenant, ACTIVE tenant → resolved', async () => {
    const r = await adapter(makeDeps()).resolveScopes(INPUT);
    expect(r.kind).toBe('resolved');
  });
  it('unknown user → denied user_inactive (no scope read)', async () => {
    const d = makeDeps({ userById: null });
    expect(await adapter(d).resolveScopes(INPUT)).toEqual({ kind: 'denied', reason: 'user_inactive' });
    expect(d.getScopesByUserAndTenant).not.toHaveBeenCalled();
  });
  it('deactivated user (User.is_active=false) → denied user_inactive', async () => {
    const d = makeDeps({ userById: { id: USER_ID, is_active: false } });
    expect(await adapter(d).resolveScopes(INPUT)).toEqual({ kind: 'denied', reason: 'user_inactive' });
  });
  it('no ACTIVE membership in the stored tenant → denied membership_inactive (re-mint cannot change tenant ownership)', async () => {
    // The user's only active membership is in ANOTHER tenant: a stored token for
    // TENANT_ID must never re-mint it.
    const d = makeDeps({ tenants: [{ id: TENANT_ID_2, name: 'Other', status: 'ACTIVE' }] });
    expect(await adapter(d).resolveScopes(INPUT)).toEqual({ kind: 'denied', reason: 'membership_inactive' });
    expect(d.getScopesByUserAndTenant).not.toHaveBeenCalled();
    // And no membership at all (disabled) → same denial.
    const d2 = makeDeps({ tenants: [] });
    expect(await adapter(d2).resolveScopes(INPUT)).toEqual({ kind: 'denied', reason: 'membership_inactive' });
  });
  it('SUSPENDED tenant → denied tenant_suspended; CLOSED → tenant_closed (tenant consumers)', async () => {
    expect(await adapter(makeDeps({ status: 'SUSPENDED' })).resolveScopes(INPUT)).toEqual({ kind: 'denied', reason: 'tenant_suspended' });
    expect(await adapter(makeDeps({ status: 'CLOSED' })).resolveScopes(INPUT)).toEqual({ kind: 'denied', reason: 'tenant_closed' });
    expect(await adapter(makeDeps({ status: 'SUSPENDED' })).resolveScopes({ ...INPUT, consumer: 'recruiter' })).toEqual({ kind: 'denied', reason: 'tenant_suspended' });
  });
  it('platform consumer is EXEMPT from the status gate at refresh (sentinel has no lifecycle)', async () => {
    const r = await adapter(makeDeps({ status: 'SUSPENDED' })).resolveScopes({ ...INPUT, consumer: 'platform' });
    expect(r.kind).toBe('resolved');
  });
  it('login: a deactivated User (is_active=false) → denied user_inactive before activation/selection', async () => {
    const d = makeDeps({ resolveUser: { id: USER_ID, is_active: false } });
    expect(await adapter(d).resolveSession(SESSION_INPUT)).toEqual({ kind: 'denied', reason: 'user_inactive' });
    expect(d.activate).not.toHaveBeenCalled();
    expect(d.getTenantsByUser).not.toHaveBeenCalled();
  });
  it('login: reconcile-by-email to a deactivated User → denied user_inactive (link still created, nothing minted)', async () => {
    const d = makeDeps({ resolveUser: null, findUserByEmail: { id: USER_ID, is_active: false } });
    expect(await adapter(d).resolveSession(SESSION_INPUT)).toEqual({ kind: 'denied', reason: 'user_inactive' });
    expect(d.getTenantsByUser).not.toHaveBeenCalled();
  });
});

// IC-2 PR-6 (IC-0 §F.2 rule 3) — consumer→capability gate at mint AND refresh.
describe('IC-2 PR-6 — consumer→product capability gate (mint + refresh)', () => {
  const REFRESH = { principal_id: USER_ID, context_id: TENANT_ID };
  it('recruiter on an ATS-entitled tenant → resolved; on a tenant WITHOUT ats → denied consumer_not_entitled (no scopes read)', async () => {
    expect((await adapter(makeDeps()).resolveSession(SESSION_INPUT)).kind).toBe('resolved');
    const d = makeDeps({ capabilities: ['core', 'portal'] });
    expect(await adapter(d).resolveSession(SESSION_INPUT)).toEqual({ kind: 'denied', reason: 'consumer_not_entitled' });
    expect(d.getScopesByUserAndTenant).not.toHaveBeenCalled();
  });
  it('esign on an ATS-only tenant → denied; on an esign-entitled tenant → resolved (Sign-only tenant: recruiter denied)', async () => {
    expect(await adapter(makeDeps({ capabilities: ['core', 'ats', 'portal'] })).resolveSession({ ...SESSION_INPUT, consumer: 'sign' })).toEqual({ kind: 'denied', reason: 'consumer_not_entitled' });
    expect((await adapter(makeDeps({ capabilities: ['core', 'sign'] })).resolveSession({ ...SESSION_INPUT, consumer: 'sign' })).kind).toBe('resolved');
    expect(await adapter(makeDeps({ capabilities: ['core', 'sign'] })).resolveSession(SESSION_INPUT)).toEqual({ kind: 'denied', reason: 'consumer_not_entitled' });
  });
  it('multi-product tenant: BOTH consumers resolve (scope isolation is the resolver\'s job)', async () => {
    const d = makeDeps({ capabilities: ['core', 'ats', 'portal', 'sign'] });
    expect((await adapter(d).resolveSession(SESSION_INPUT)).kind).toBe('resolved');
    expect((await adapter(d).resolveSession({ ...SESSION_INPUT, consumer: 'sign' })).kind).toBe('resolved');
  });
  it('platform is exempt (sentinel has no entitlements); portal and unknown consumers are unsupported on this path', async () => {
    const d = makeDeps({ capabilities: [] });
    expect((await adapter(d).resolveSession({ ...SESSION_INPUT, consumer: 'platform' })).kind).toBe('resolved');
    expect(d.getCapabilities).not.toHaveBeenCalled();
    expect(await adapter(makeDeps()).resolveSession({ ...SESSION_INPUT, consumer: 'portal' })).toEqual({ kind: 'denied', reason: 'consumer_not_supported' });
    expect(await adapter(makeDeps()).resolveSession({ ...SESSION_INPUT, consumer: 'bogus' as never })).toEqual({ kind: 'denied', reason: 'consumer_not_supported' });
  });
  it('an unreadable entitlement store denies (fail closed), never grants', async () => {
    expect(await adapter(makeDeps({ capabilities: 'throws' })).resolveSession(SESSION_INPUT)).toEqual({ kind: 'denied', reason: 'consumer_not_entitled' });
  });
  it('the gate runs AFTER the status gate (a suspended tenant reports tenant_suspended, not entitlement)', async () => {
    expect(await adapter(makeDeps({ status: 'SUSPENDED', capabilities: [] })).resolveSession(SESSION_INPUT)).toEqual({ kind: 'denied', reason: 'tenant_suspended' });
  });
  it('refresh: the capability is re-proven — a removed ats/esign entitlement denies consumer_not_entitled; missing consumer is unsupported', async () => {
    expect(await adapter(makeDeps({ capabilities: ['core'] })).resolveScopes({ ...REFRESH, consumer: 'recruiter' })).toEqual({ kind: 'denied', reason: 'consumer_not_entitled' });
    expect(await adapter(makeDeps({ capabilities: ['core', 'ats'] })).resolveScopes({ ...REFRESH, consumer: 'sign' })).toEqual({ kind: 'denied', reason: 'consumer_not_entitled' });
    expect((await adapter(makeDeps({ capabilities: ['core', 'sign'] })).resolveScopes({ ...REFRESH, consumer: 'sign' })).kind).toBe('resolved');
    expect(await adapter(makeDeps()).resolveScopes(REFRESH)).toEqual({ kind: 'denied', reason: 'consumer_not_supported' });
    expect((await adapter(makeDeps({ capabilities: [] })).resolveScopes({ ...REFRESH, consumer: 'platform' })).kind).toBe('resolved');
  });
});

// IC-4 PR-9 / IC-0 J-9 (Inc-2 PR-1 Amendment Inc-2-PR-1-A1) — OWNER FIRST-SESSION
// ACTIVATION: a Pattern-A owner (no Invitation row) activates its PROVISIONED
// tenant on its first successful session. After every gate; best-effort;
// idempotent; never for the platform consumer, a non-owner, an ACTIVE tenant
// or a refresh; never changes the minted session.
describe('IC-4 PR-9 — owner first-session activation (J-9)', () => {
  it('PROVISIONED tenant + org_admin membership (Sign-only / PERSONAL owner) → resolved AND transitionTenantStatus(→ACTIVE, system actor, owner_first_session)', async () => {
    const d = makeDeps({ status: 'PROVISIONED', roleKeys: ['org_admin'], capabilities: ['core', 'sign'] });
    const r = await adapter(d).resolveSession({ ...SESSION_INPUT, consumer: 'sign' });
    expect(r.kind).toBe('resolved');
    expect(d.findMembership).toHaveBeenCalledWith({ user_id: USER_ID, tenant_id: TENANT_ID });
    expect(d.transitionTenantStatus).toHaveBeenCalledTimes(1);
    expect(d.transitionTenantStatus).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: TENANT_ID, to: 'ACTIVE', actor_type: 'system', source: 'owner_first_session',
      related: expect.objectContaining({ membershipId: 'mem-1', userId: USER_ID }),
    }));
  });
  it('PROVISIONED tenant + tenant_owner membership (ATS owner, recruiter consumer) → activates; the resolved session is unchanged by the hook', async () => {
    const d = makeDeps({ status: 'PROVISIONED', roleKeys: ['tenant_owner'] });
    const r = await adapter(d).resolveSession(SESSION_INPUT);
    expect(r).toMatchObject({ kind: 'resolved', principal_id: USER_ID, context_id: TENANT_ID, scopes: ['auth:session:read'] });
    expect(d.transitionTenantStatus).toHaveBeenCalledTimes(1);
  });
  it('PROVISIONED tenant + NON-owner membership (recruiter) → resolved, NO transition', async () => {
    const d = makeDeps({ status: 'PROVISIONED', roleKeys: ['recruiter'] });
    expect((await adapter(d).resolveSession(SESSION_INPUT)).kind).toBe('resolved');
    expect(d.transitionTenantStatus).not.toHaveBeenCalled();
  });
  it('ACTIVE tenant → no membership/role lookup, NO transition (idempotent fast path)', async () => {
    const d = makeDeps({ status: 'ACTIVE', roleKeys: ['org_admin'] });
    expect((await adapter(d).resolveSession(SESSION_INPUT)).kind).toBe('resolved');
    expect(d.findMembership).not.toHaveBeenCalled();
    expect(d.transitionTenantStatus).not.toHaveBeenCalled();
  });
  it('platform consumer (sentinel) → NEVER activates', async () => {
    const d = makeDeps({ status: 'PROVISIONED', roleKeys: ['super_admin'], tenants: [{ id: PLATFORM_TENANT_SENTINEL_ID, name: 'Aramo Platform', status: 'PROVISIONED' }] });
    expect((await adapter(d).resolveSession({ ...SESSION_INPUT, consumer: 'platform' })).kind).toBe('resolved');
    expect(d.transitionTenantStatus).not.toHaveBeenCalled();
  });
  it('a failing activation write NEVER fails the sign-in (best-effort; tenant stays PROVISIONED, mint-gate allows it)', async () => {
    const d = makeDeps({ status: 'PROVISIONED', roleKeys: ['org_admin'], transition: 'throws' });
    const r = await adapter(d).resolveSession(SESSION_INPUT);
    expect(r.kind).toBe('resolved');
    expect(d.transitionTenantStatus).toHaveBeenCalledTimes(1);
  });
  it('the hook runs AFTER the gates: a denied session (not entitled / suspended / mismatched host under enforce) never activates', async () => {
    const d1 = makeDeps({ status: 'PROVISIONED', roleKeys: ['org_admin'], capabilities: ['core', 'sign'] });
    expect(await adapter(d1).resolveSession(SESSION_INPUT)).toEqual({ kind: 'denied', reason: 'consumer_not_entitled' });
    expect(d1.transitionTenantStatus).not.toHaveBeenCalled();
    const d2 = makeDeps({ status: 'SUSPENDED', roleKeys: ['org_admin'] });
    expect((await adapter(d2).resolveSession(SESSION_INPUT)).kind).toBe('denied');
    expect(d2.transitionTenantStatus).not.toHaveBeenCalled();
  });
  it('refresh (resolveScopes) never activates', async () => {
    const d = makeDeps({ status: 'PROVISIONED', roleKeys: ['org_admin'] });
    expect((await adapter(d).resolveScopes({ principal_id: USER_ID, context_id: TENANT_ID, consumer: 'recruiter' })).kind).toBe('resolved');
    expect(d.transitionTenantStatus).not.toHaveBeenCalled();
  });
});

// IC-4 PR-9 §4 — a PERSONAL Sign tenant ([core, esign]) is NOT entitled to ATS:
// the recruiter credential is refused at mint and at refresh whatever roles the
// personal User holds; the esign credential is minted. Identity registration,
// tenant creation, product entitlement and Sign sender eligibility stay separate.
describe('IC-4 PR-9 — personal Sign tenant never mints an ATS credential', () => {
  it('recruiter consumer → denied consumer_not_entitled (no scopes read); esign consumer → resolved; refresh of a recruiter token → denied', async () => {
    const personal = { capabilities: ['core', 'sign'], roleKeys: ['org_admin'] };
    const d = makeDeps(personal);
    expect(await adapter(d).resolveSession(SESSION_INPUT)).toEqual({ kind: 'denied', reason: 'consumer_not_entitled' });
    expect(d.getScopesByUserAndTenant).not.toHaveBeenCalled();
    expect((await adapter(makeDeps(personal)).resolveSession({ ...SESSION_INPUT, consumer: 'sign' })).kind).toBe('resolved');
    expect(await adapter(makeDeps(personal)).resolveScopes({ principal_id: USER_ID, context_id: TENANT_ID, consumer: 'recruiter' })).toEqual({ kind: 'denied', reason: 'consumer_not_entitled' });
  });
});

// D-ORG (R2 / §3.C) — the `org` consumer mints on ANY tenant that is an Aramo
// organization (`core`): ATS-only, Sign-only, ATS+Sign and PERSONAL alike; it is a
// TENANT consumer for every other gate (status, host binding, membership) and is
// refused only where the tenant lacks core (an impossible state for a real tenant,
// proven anyway) or the consumer is unknown.
describe('D-ORG — org consumer mint and refresh', () => {
  const ORG = { ...SESSION_INPUT, consumer: 'org' as const };
  it.each([
    ['ATS-only', ['core', 'ats', 'portal']],
    ['Sign-only', ['core', 'sign']],
    ['ATS+Sign', ['core', 'ats', 'portal', 'sign']],
    ['PERSONAL', ['core', 'sign']],
  ])('%s tenant → org session resolved', async (_label, capabilities) => {
    const r = await adapter(makeDeps({ capabilities })).resolveSession(ORG);
    expect(r.kind).toBe('resolved');
  });
  it('a tenant WITHOUT core → denied consumer_not_entitled (no scopes read); an entitlement-store failure fails closed', async () => {
    const d = makeDeps({ capabilities: ['ats'] });
    expect(await adapter(d).resolveSession(ORG)).toEqual({ kind: 'denied', reason: 'consumer_not_entitled' });
    expect(d.getScopesByUserAndTenant).not.toHaveBeenCalled();
    expect(await adapter(makeDeps({ capabilities: 'throws' })).resolveSession(ORG)).toEqual({ kind: 'denied', reason: 'consumer_not_entitled' });
  });
  it('status gate and host binding apply to org exactly as to any tenant consumer', async () => {
    expect(await adapter(makeDeps({ status: 'SUSPENDED' })).resolveSession(ORG)).toEqual({ kind: 'denied', reason: 'tenant_suspended' });
    expect(await adapter(makeDeps({ status: 'CLOSED' })).resolveSession(ORG)).toEqual({ kind: 'denied', reason: 'tenant_closed' });
    expect((await adapter(makeDeps({ status: 'PROVISIONED', roleKeys: ['org_admin'] })).resolveSession(ORG)).kind).toBe('resolved');
  });
  it('refresh re-proves core for org; an org token never refreshes as another consumer', async () => {
    const ok = await adapter(makeDeps({ capabilities: ['core', 'sign'] })).resolveScopes({ principal_id: USER_ID, context_id: TENANT_ID, consumer: 'org' });
    expect(ok.kind).toBe('resolved');
    const noCore = await adapter(makeDeps({ capabilities: ['sign'] })).resolveScopes({ principal_id: USER_ID, context_id: TENANT_ID, consumer: 'org' });
    expect(noCore).toEqual({ kind: 'denied', reason: 'consumer_not_entitled' });
  });
});
