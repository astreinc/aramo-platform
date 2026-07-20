import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  IdentityAuditService,
  IdentityService,
  RoleService,
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
}

function makeDeps(over: {
  resolveUser?: unknown;
  findUserByEmail?: unknown;
  tenants?: unknown[];
  status?: string;
  activateImpl?: () => Promise<unknown>;
  site?: string | null;
  order?: string[];
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
} {
  const order = over.order;
  const resolveUser = vi
    .fn()
    .mockResolvedValue(over.resolveUser === undefined ? { id: USER_ID } : over.resolveUser);
  const findUserByEmail = vi
    .fn()
    .mockResolvedValue(over.findUserByEmail === undefined ? null : over.findUserByEmail);
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

  const identity = {
    resolveUser,
    findUserByEmail,
    linkExternalIdentity,
    activateAcceptedMembershipsOnSession: activate,
  } as unknown as IdentityService;
  const tenant = { getTenantsByUser } as unknown as TenantService;
  const role = {
    findActiveMembershipSite,
    getScopesByUserAndTenant,
    getScopesByUserTenantAndSite,
  } as unknown as RoleService;
  const audit = { writeGlobalEvent } as unknown as IdentityAuditService;

  return {
    identity, tenant, role, audit,
    resolveUser, findUserByEmail, linkExternalIdentity, activate, getTenantsByUser,
    findActiveMembershipSite, getScopesByUserAndTenant, getScopesByUserTenantAndSite, writeGlobalEvent,
  };
}

function adapter(d: Deps): IdentityPrincipalDirectoryAdapter {
  return new IdentityPrincipalDirectoryAdapter(d.identity, d.tenant, d.role, d.audit);
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

  it('AMBIGUOUS: >1 active tenant → choices', async () => {
    const d = makeDeps({
      tenants: [
        { id: TENANT_ID, name: 'Tenant One' },
        { id: TENANT_ID_2, name: 'Tenant Two' },
      ],
    });
    const r = await adapter(d).resolveSession(SESSION_INPUT);
    expect(r.kind).toBe('ambiguous');
    if (r.kind !== 'ambiguous') return;
    expect(r.choices).toEqual([
      { id: TENANT_ID, name: 'Tenant One' },
      { id: TENANT_ID_2, name: 'Tenant Two' },
    ]);
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
    const r = await adapter(d).resolveScopes({ principal_id: USER_ID, context_id: TENANT_ID });
    expect(r).toEqual({ scopes: ['talent:read'], claims: { site_id: SITE_ID } });
  });

  it('resolveScopes tenant-wide → { scopes } (no claims)', async () => {
    const d = makeDeps({ site: null });
    const r = await adapter(d).resolveScopes({ principal_id: USER_ID, context_id: TENANT_ID });
    expect(r).toEqual({ scopes: ['auth:session:read'] });
  });
});
