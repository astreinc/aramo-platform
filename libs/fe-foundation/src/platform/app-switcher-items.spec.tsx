import { describe, expect, it } from 'vitest';

import { buildAppSwitcherItems } from './app-switcher-items';
import { productEntryHref, type ProductAvailabilityView } from './products';

// App switcher rows (App Home handoff §3) — strictly from the backend
// availability read; the external signer app is never a row.
const view = (over: Partial<Record<'ats' | 'esign' | 'org', { subscribed: boolean; authorized: boolean; available: boolean; entry_path: string | null }>>): ProductAvailabilityView => ({
  tenant_id: 't',
  products: (['ats', 'esign', 'org'] as const).map((key) => ({
    key,
    subscribed: false,
    authorized: false,
    available: false,
    entry_path: null,
    reason: 'not_subscribed' as const,
    ...over[key],
  })),
});

describe('buildAppSwitcherItems', () => {
  it('from App Home: home is current; an available ATS opens at its entry path; unsubscribed Sign is not a link; org appears only when available', () => {
    const items = buildAppSwitcherItems({
      current: 'home',
      products: view({ ats: { subscribed: true, authorized: true, available: true, entry_path: '/ats/' } }),
    });
    expect(items.map((i) => i.key)).toEqual(['home', 'ats', 'sign']);
    expect(items[0]).toMatchObject({ state: 'current', sub: 'You are here', to: '/' });
    expect(items[1]).toMatchObject({ state: 'open', href: '/ats/' });
    expect(items[2]).toMatchObject({ state: 'unavailable', sub: 'Not part of your plan' });
    expect(items[2]?.href).toBeUndefined();
  });

  it('from the ATS: ATS is current, App Home and Organization are host-level links; no-access and not-activated read honestly', () => {
    const items = buildAppSwitcherItems({
      current: 'ats',
      products: view({
        ats: { subscribed: true, authorized: true, available: true, entry_path: '/ats/' },
        esign: { subscribed: true, authorized: true, available: false, entry_path: null },
        org: { subscribed: true, authorized: true, available: true, entry_path: '/org/' },
      }),
    });
    expect(items.find((i) => i.key === 'home')).toMatchObject({ state: 'open', href: '/' });
    expect(items.find((i) => i.key === 'ats')).toMatchObject({ state: 'current' });
    expect(items.find((i) => i.key === 'sign')).toMatchObject({ state: 'unavailable', sub: 'Not available yet' });
    expect(items.find((i) => i.key === 'org')).toMatchObject({ state: 'open', href: '/org/' });
  });

  it('no availability read yet (loading/error): products are not links; never a signer-app row', () => {
    const items = buildAppSwitcherItems({ current: 'home', products: null });
    expect(items.filter((i) => i.state === 'open')).toEqual([]);
    expect(JSON.stringify(items)).not.toContain('/s/');
  });
});

describe('productEntryHref — Sign on its own host', () => {
  const base = { subscribed: true, authorized: true, available: true, reason: null } as const;
  it('opens an absolute https product-host entry directly, and tenant-host paths as-is', () => {
    expect(productEntryHref({ key: 'esign', ...base, entry_path: 'https://esign.aramo.ai/' })).toBe('https://esign.aramo.ai/');
    expect(productEntryHref({ key: 'ats', ...base, entry_path: '/ats/' })).toBe('/ats/');
  });
  it('never links a non-http(s) or protocol-relative entry', () => {
    expect(productEntryHref({ key: 'esign', ...base, entry_path: 'javascript:alert(1)' })).toBeNull();
    expect(productEntryHref({ key: 'esign', ...base, entry_path: '//evil.example/' })).toBeNull();
  });
});
