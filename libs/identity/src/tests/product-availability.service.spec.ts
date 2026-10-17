import { afterEach, describe, expect, it } from 'vitest';

import { ProductAvailabilityService } from '../lib/authorization/product-availability.service.js';
import type { RoleService } from '../lib/role.service.js';
import type { TenantEntitlementReader } from '../lib/tenant-entitlement-reader.service.js';

// D-ORG (R5 / §3.D) — the backend-authoritative App Home projection: subscribed
// (tenant entitlement) ≠ authorized (user's product-namespace scopes) ≠ available
// (both + activation). Never grants; never exposes roles/scopes.

const T = '01900000-0000-7000-8000-000000000001';
const U = '01900000-0000-7000-8000-0000000000aa';

function svc(caps: string[], held: string[]): ProductAvailabilityService {
  const roles = { getScopesByUserAndTenant: async () => held } as unknown as RoleService;
  const entitlements = { getCapabilities: async () => new Set(caps) } as unknown as TenantEntitlementReader;
  return new ProductAvailabilityService(roles, entitlements);
}
const byKey = (v: { products: readonly { key: string }[] }) => Object.fromEntries(v.products.map((p) => [p.key, p])) as Record<string, { subscribed: boolean; authorized: boolean; available: boolean; entry_path: string | null; reason: string | null }>;

const RECRUITER = ['auth:session:read', 'talent:read', 'requisition:read'];
const ORG_ADMIN = ['auth:session:read', 'tenant:admin:user-manage', 'tenant:admin:profile', 'audit:read'];
const SIGN_SENDER = ['auth:session:read', 'esign:envelope:create', 'esign:envelope:send', 'esign:envelope:read'];

describe('ProductAvailabilityService (D-ORG)', () => {
  afterEach(() => {
    delete process.env['ARAMO_SIGN_ENTRY_ENABLED'];
  });

  it('ATS-only tenant, recruiter: ATS available at /ats/; Sign not_subscribed; Organization subscribed (core) but not_authorized (no admin scope)', async () => {
    const p = byKey(await svc(['core', 'ats', 'portal'], RECRUITER).forPrincipal({ user_id: U, tenant_id: T }));
    expect(p['ats']).toEqual({ key: 'ats', subscribed: true, authorized: true, available: true, entry_path: '/ats/', reason: null });
    expect(p['esign']).toMatchObject({ subscribed: false, authorized: false, available: false, entry_path: null, reason: 'not_subscribed' });
    expect(p['org']).toMatchObject({ subscribed: true, authorized: false, available: false, entry_path: null, reason: 'not_authorized' });
  });

  it('Sign-only tenant, org_admin + esign_sender: Organization available at /org/; ATS not_subscribed even though nothing else blocks it; Sign subscribed+authorized but not_activated while the entry is dark', async () => {
    const p = byKey(await svc(['core', 'esign'], [...ORG_ADMIN, ...SIGN_SENDER]).forPrincipal({ user_id: U, tenant_id: T }));
    expect(p['org']).toEqual({ key: 'org', subscribed: true, authorized: true, available: true, entry_path: '/org/', reason: null });
    expect(p['ats']).toMatchObject({ subscribed: false, reason: 'not_subscribed', entry_path: null });
    expect(p['esign']).toMatchObject({ subscribed: true, authorized: true, available: false, entry_path: null, reason: 'not_activated' });
  });

  it('Sign entry activation flag turns an authorized, subscribed Sign into available with its entry path — and nothing else changes', async () => {
    process.env['ARAMO_SIGN_ENTRY_ENABLED'] = 'true';
    const p = byKey(await svc(['core', 'ats', 'portal', 'esign'], [...RECRUITER, ...SIGN_SENDER]).forPrincipal({ user_id: U, tenant_id: T }));
    expect(p['esign']).toEqual({ key: 'esign', subscribed: true, authorized: true, available: true, entry_path: '/sign/', reason: null });
    expect(p['ats'].available).toBe(true);
    expect(p['org']).toMatchObject({ available: false, reason: 'not_authorized' });
  });

  it('subscription without roles grants nothing: ATS+Sign tenant, a recruiter-only member sees Sign subscribed=true, authorized=false (no bulk grant)', async () => {
    const p = byKey(await svc(['core', 'ats', 'portal', 'esign'], RECRUITER).forPrincipal({ user_id: U, tenant_id: T }));
    expect(p['esign']).toMatchObject({ subscribed: true, authorized: false, available: false, reason: 'not_authorized' });
  });

  it('a Sign role held in an ATS-only tenant is reported authorized=true but not_subscribed (operator-meaningful, never navigable)', async () => {
    const p = byKey(await svc(['core', 'ats', 'portal'], SIGN_SENDER).forPrincipal({ user_id: U, tenant_id: T }));
    expect(p['esign']).toMatchObject({ subscribed: false, authorized: true, available: false, reason: 'not_subscribed' });
  });

  it('the org subset ridden by an ATS role (e.g. tenant_owner) makes Organization authorized; an ordinary baseline marker does not', async () => {
    const owner = byKey(await svc(['core', 'ats', 'portal'], [...RECRUITER, 'tenant:admin:user-manage']).forPrincipal({ user_id: U, tenant_id: T }));
    expect(owner['org'].available).toBe(true);
    const member = byKey(await svc(['core', 'ats', 'portal'], ['auth:session:read']).forPrincipal({ user_id: U, tenant_id: T }));
    expect(member['org']).toMatchObject({ authorized: false, reason: 'not_authorized' });
    expect(member['ats']).toMatchObject({ authorized: false, reason: 'not_authorized' });
  });

  it('exposes exactly the projection fields — no roles, scopes or members', async () => {
    const v = await svc(['core', 'ats'], RECRUITER).forPrincipal({ user_id: U, tenant_id: T });
    expect(Object.keys(v).sort()).toEqual(['products', 'tenant_id']);
    for (const p of v.products) expect(Object.keys(p).sort()).toEqual(['authorized', 'available', 'entry_path', 'key', 'reason', 'subscribed']);
    expect(v.products.map((p) => p.key)).toEqual(['ats', 'esign', 'org']);
  });
});
