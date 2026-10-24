import 'reflect-metadata';

import type { AuthContextType } from '@aramo/auth';
import { REQUIRED_SCOPES_KEY } from '@aramo/authorization';
import type {
  DomainClaimService,
  IdentityAuditRepository,
  IdentityRepository,
  TenantRepository,
  TenantService,
} from '@aramo/identity';
import { describe, expect, it, vi } from 'vitest';

import { PlatformController } from '../app/platform/platform.controller.js';
import type { PlatformInvitationService } from '../app/platform/platform-invitation.service.js';

// PLATFORM-UX-1 B-1a / B-1b — unit proofs for GET /platform/me (caller-only
// identity read) and the additive `slug` on GET /platform/tenants/:tenant_id.
// The HTTP-level scope + tier gates are proven against real Postgres in
// platform-me.integration.spec.ts.

const SENTINEL = '01900000-0000-7000-8000-000000000100';
const CALLER = '019a0000-0000-7000-8000-0000000000c1';
const T = '019a0000-0000-7000-8000-0000000000aa';

const auth = (consumer_type: string, sub = CALLER, tenant_id = SENTINEL) =>
  ({ sub, tenant_id, scopes: ['platform:tenant:read'], consumer_type }) as unknown as AuthContextType;

function build(opts: {
  meContext?: unknown;
  tenant?: unknown;
  slug?: string | null;
} = {}) {
  const identityRepo = {
    findMeContext: vi.fn(async () =>
      opts.meContext === undefined
        ? {
            email: 'ops@aramo.ai',
            display_name: 'Ops Person',
            roles: [
              { key: 'super_admin', description: 'Platform Super Admin' },
              { key: 'auditor', description: 'Auditor' },
            ],
            tenant_name: 'Aramo Platform',
            tenant_display_name: null,
            tenant_status: 'ACTIVE',
          }
        : opts.meContext,
    ),
  };
  const tenantRepo = { findSlugById: vi.fn(async () => (opts.slug === undefined ? 'acme' : opts.slug)) };
  const tenantSvc = {
    getTenantById: vi.fn(async () =>
      opts.tenant === undefined
        ? {
            id: T,
            name: 'Acme',
            is_active: true,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
            identity_provider: null,
            status: 'ACTIVE',
            kind: 'BUSINESS',
          }
        : opts.tenant,
    ),
  };
  const c = new PlatformController(
    {} as unknown as PlatformInvitationService,
    tenantSvc as unknown as TenantService,
    {} as unknown as IdentityAuditRepository,
    {} as unknown as DomainClaimService,
    identityRepo as unknown as IdentityRepository,
    tenantRepo as unknown as TenantRepository,
  );
  return { c, identityRepo, tenantRepo, tenantSvc };
}

describe('PlatformController — GET /platform/me (B-1a)', () => {
  it('declares platform:tenant:read', () => {
    const scopes = Reflect.getMetadata(REQUIRED_SCOPES_KEY, PlatformController.prototype.getMe);
    expect(scopes).toEqual(['platform:tenant:read']);
  });

  it("returns the caller's own identity, keyed only by the token sub + tenant_id", async () => {
    const { c, identityRepo } = build();
    const res = await c.getMe(auth('platform'), 'r');
    expect(identityRepo.findMeContext).toHaveBeenCalledTimes(1);
    expect(identityRepo.findMeContext).toHaveBeenCalledWith({ user_id: CALLER, tenant_id: SENTINEL });
    expect(res).toEqual({
      user_id: CALLER,
      email: 'ops@aramo.ai',
      display_name: 'Ops Person',
      tenant_id: SENTINEL,
      tenant_name: 'Aramo Platform',
      // Role KEYS (not display names), sorted.
      role_keys: ['auditor', 'super_admin'],
    });
    // Exactly the six fields: nothing else (no other principal, no scopes).
    expect(Object.keys(res).sort()).toEqual(
      ['display_name', 'email', 'role_keys', 'tenant_id', 'tenant_name', 'user_id'],
    );
  });

  it('prefers the tenant display name when set', async () => {
    const { c } = build({
      meContext: {
        email: 'ops@aramo.ai',
        display_name: null,
        roles: [],
        tenant_name: 'aramo-platform',
        tenant_display_name: 'Aramo Platform Ops',
        tenant_status: 'ACTIVE',
      },
    });
    const res = await c.getMe(auth('platform'), 'r');
    expect(res.tenant_name).toBe('Aramo Platform Ops');
    expect(res.display_name).toBeNull();
    expect(res.role_keys).toEqual([]);
  });

  it('refuses a non-platform consumer (tier tripwire) before any identity read', async () => {
    const { c, identityRepo } = build();
    await expect(c.getMe(auth('recruiter'), 'r')).rejects.toMatchObject({
      code: 'INSUFFICIENT_PERMISSIONS',
      statusCode: 403,
      context: { details: { reason: 'tier_mismatch', consumer_type: 'recruiter' } },
    });
    expect(identityRepo.findMeContext).not.toHaveBeenCalled();
  });

  it('404s when the caller has no membership in the token tenant', async () => {
    const { c } = build({ meContext: null });
    await expect(c.getMe(auth('platform'), 'r')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
  });
});

describe('PlatformController — GET /platform/tenants/:tenant_id slug (B-1b)', () => {
  it('adds slug to the TenantDto shape (additive; every TenantDto field kept)', async () => {
    const { c, tenantRepo } = build({ slug: 'acme' });
    const res = await c.getTenant(T, auth('platform'), 'r');
    expect(tenantRepo.findSlugById).toHaveBeenCalledWith(T);
    expect(res.tenant).toEqual({
      id: T,
      name: 'Acme',
      is_active: true,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      identity_provider: null,
      status: 'ACTIVE',
      kind: 'BUSINESS',
      slug: 'acme',
    });
  });

  it('slug is null for a tenant with no subdomain', async () => {
    const { c } = build({ slug: null });
    const res = await c.getTenant(T, auth('platform'), 'r');
    expect(res.tenant.slug).toBeNull();
  });

  it('404s an unknown tenant without reading the slug', async () => {
    const { c, tenantRepo } = build({ tenant: null });
    await expect(c.getTenant(T, auth('platform'), 'r')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
    expect(tenantRepo.findSlugById).not.toHaveBeenCalled();
  });
});
