import { AramoError } from '@aramo/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TenantProfileRow } from '../lib/tenant.repository.js';
import { TenantProfileService } from '../lib/tenant-profile/tenant-profile.service.js';
import { validateProfilePatch } from '../lib/tenant-profile/tenant-profile.view.js';

// Settings Rebuild Directive 3 — tenant-profile validation + service.

const RID = 'rq-d3-001';

function row(over: Partial<TenantProfileRow> = {}): TenantProfileRow {
  return {
    id: 't1',
    name: 'Astre',
    legal_name: null,
    display_name: null,
    address_line1: null,
    address_line2: null,
    city: null,
    state_province: null,
    postal_code: null,
    country_code: null,
    tax_id: null,
    registration_number: null,
    primary_contact_name: null,
    primary_contact_email: null,
    primary_contact_phone: null,
    logo_url: null,
    updated_at: new Date('2026-06-19T00:00:00.000Z'),
    ...over,
  };
}

describe('validateProfilePatch', () => {
  it('accepts known fields, trims, and coerces empty → null (clear)', () => {
    const patch = validateProfilePatch(
      { legal_name: '  Astre Consulting  ', city: '' },
      RID,
    );
    expect(patch).toEqual({ legal_name: 'Astre Consulting', city: null });
  });

  it('rejects an unknown field (defense-in-depth, not silent strip)', () => {
    expect(() => validateProfilePatch({ name: 'hacked' }, RID)).toThrow(AramoError);
    expect(() => validateProfilePatch({ bogus: 'x' }, RID)).toThrow(/unknown profile field/);
  });

  it('validates email / country_code / logo_url and uppercases country', () => {
    expect(() => validateProfilePatch({ primary_contact_email: 'nope' }, RID)).toThrow(/valid email/);
    expect(() => validateProfilePatch({ country_code: '12' }, RID)).toThrow(/2-letter/);
    expect(() => validateProfilePatch({ logo_url: 'javascript:alert(1)' }, RID)).toThrow(/http/);
    expect(validateProfilePatch({ country_code: 'us' }, RID)).toEqual({ country_code: 'US' });
    expect(validateProfilePatch({ logo_url: 'https://x.com/l.png' }, RID)).toEqual({
      logo_url: 'https://x.com/l.png',
    });
  });

  it('rejects over-long values and non-string types', () => {
    expect(() => validateProfilePatch({ city: 'x'.repeat(200) }, RID)).toThrow(/exceeds/);
    expect(() => validateProfilePatch({ legal_name: 42 as never }, RID)).toThrow(/must be a string/);
  });

  it('null explicitly clears a field', () => {
    expect(validateProfilePatch({ tax_id: null }, RID)).toEqual({ tax_id: null });
  });
});

function makeService(current: TenantProfileRow | null) {
  const findProfileById = vi.fn(async () => current);
  const updateProfile = vi.fn(async (_id: string, patch: Record<string, string | null>) =>
    row({ ...(current ?? row()), ...patch }),
  );
  const svc = new TenantProfileService({ findProfileById, updateProfile } as never);
  return { svc, findProfileById, updateProfile };
}

describe('TenantProfileService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getProfile returns the view; 404 when the tenant is missing', async () => {
    const { svc } = makeService(row({ legal_name: 'Astre Inc' }));
    const view = await svc.getProfile('t1', RID);
    expect(view.legal_name).toBe('Astre Inc');
    expect(view.name).toBe('Astre');

    const { svc: missing } = makeService(null);
    await expect(missing.getProfile('t1', RID)).rejects.toThrow(AramoError);
  });

  it('updateProfile reports only the fields that ACTUALLY changed', async () => {
    const { svc, updateProfile } = makeService(row({ legal_name: 'Old', city: 'NYC' }));
    const res = await svc.updateProfile({
      tenantId: 't1',
      body: { legal_name: 'New', city: 'NYC' }, // city unchanged
      requestId: RID,
    });
    expect(res.changedFields).toEqual(['legal_name']);
    expect(updateProfile).toHaveBeenCalledWith('t1', { legal_name: 'New' });
  });

  it('a no-op PATCH writes nothing and reports no changes (no-op-no-audit)', async () => {
    const { svc, updateProfile } = makeService(row({ legal_name: 'Same' }));
    const res = await svc.updateProfile({
      tenantId: 't1',
      body: { legal_name: 'Same' },
      requestId: RID,
    });
    expect(res.changedFields).toEqual([]);
    expect(updateProfile).not.toHaveBeenCalled();
  });
});

// Sign Signup Amendment A1 (LOCKED) §2.5 — a tenant held to the US region keeps a
// complete US organization profile; tenants without a lock are unchanged.
describe('TenantProfileService — US billing-region lock', () => {
  const usRow = () =>
    row({
      legal_name: 'Acme LLC',
      address_line1: '1 Main St',
      city: 'Austin',
      state_province: 'TX',
      postal_code: '78701',
      country_code: 'US',
      primary_contact_email: 'billing@acme.test',
    });
  function locked(region: string | null, current = usRow()) {
    const findProfileById = vi.fn(async () => current);
    const updateProfile = vi.fn(async (_id: string, patch: Record<string, string | null>) => row({ ...current, ...patch }));
    const regionSvc = { regionOf: vi.fn(async () => region) };
    const svc = new TenantProfileService({ findProfileById, updateProfile } as never, regionSvc as never);
    return { svc, updateProfile };
  }
  const reason = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return (e as AramoError).context.details?.['reason'];
    }
    return 'resolved';
  };

  it('refuses moving a locked tenant outside the US (incl. territories)', async () => {
    const { svc, updateProfile } = locked('US');
    expect(await reason(svc.updateProfile({ tenantId: 't1', body: { country_code: 'IN' }, requestId: RID }))).toBe('organization_country_not_supported');
    expect(await reason(svc.updateProfile({ tenantId: 't1', body: { state_province: 'PR' }, requestId: RID }))).toBe('organization_country_not_supported');
    expect(updateProfile).not.toHaveBeenCalled();
  });

  it('refuses clearing a required field on a locked tenant', async () => {
    const { svc } = locked('US');
    expect(await reason(svc.updateProfile({ tenantId: 't1', body: { city: null }, requestId: RID }))).toBe('organization_profile_incomplete');
  });

  it('allows ordinary edits on a locked tenant', async () => {
    const { svc, updateProfile } = locked('US');
    await svc.updateProfile({ tenantId: 't1', body: { city: 'Dallas', postal_code: '75201' }, requestId: RID });
    expect(updateProfile).toHaveBeenCalledWith('t1', { city: 'Dallas', postal_code: '75201' });
  });

  it('a tenant without a lock (e.g. Astre) is unrestricted', async () => {
    const { svc, updateProfile } = locked(null);
    await svc.updateProfile({ tenantId: 't1', body: { country_code: 'IN' }, requestId: RID });
    expect(updateProfile).toHaveBeenCalledWith('t1', { country_code: 'IN' });
  });
});
