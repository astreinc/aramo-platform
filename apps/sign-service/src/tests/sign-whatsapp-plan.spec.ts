import { describe, expect, it } from 'vitest';
import type { TenantRepository } from '@aramo/identity';

import { SignWhatsappPlanGate, whatsappEntitlementOf } from '../app/messaging/whatsapp-plan.gate.js';
import type { SignPlanFeatureReader } from '../app/custom-roles/sign-custom-roles.gate.js';

// SIGN-FREE-PARITY-1 S5 (LOCKED 2026-11-27, FP-R3) — WhatsApp delivery per plan: the plan's explicit
// entitlement wins; a version without the key falls back to the account kind (BUSINESS on, PERSONAL off).

const tenants = (kind: string | null) => ({ findById: async () => (kind === null ? null : { id: 't', kind }) }) as unknown as TenantRepository;
const reader = (setting: boolean | null | Error): SignPlanFeatureReader => ({
  planFeatureEnabled: async () => setting === true,
  planFeatureSetting: async () => {
    if (setting instanceof Error) throw setting;
    return setting;
  },
});

describe('SIGN-FREE-PARITY-1 S5 WhatsApp plan gate', () => {
  it('FP-S5-R-1 the explicit plan setting wins over the account kind', () => {
    expect(whatsappEntitlementOf(false, 'BUSINESS')).toBe(false);
    expect(whatsappEntitlementOf(true, 'PERSONAL')).toBe(true);
  });

  it('FP-S5-R-2 no setting: Business on, Personal (Free and Standard) off', () => {
    expect(whatsappEntitlementOf(null, 'BUSINESS')).toBe(true);
    expect(whatsappEntitlementOf(null, 'PERSONAL')).toBe(false);
    expect(whatsappEntitlementOf(null, null)).toBe(false);
  });

  it('FP-S5-R-3 the gate reads the plan, then the tenant kind; an unreadable store fails closed', async () => {
    expect(await new SignWhatsappPlanGate(tenants('PERSONAL'), reader(true)).entitled('t')).toBe(true);
    expect(await new SignWhatsappPlanGate(tenants('BUSINESS'), reader(false)).entitled('t')).toBe(false);
    expect(await new SignWhatsappPlanGate(tenants('BUSINESS'), reader(null)).entitled('t')).toBe(true);
    expect(await new SignWhatsappPlanGate(tenants('PERSONAL'), reader(null)).entitled('t')).toBe(false);
    expect(await new SignWhatsappPlanGate(tenants('BUSINESS'), reader(new Error('down'))).entitled('t')).toBe(false);
    expect(await new SignWhatsappPlanGate(tenants('BUSINESS')).entitled('t')).toBe(true);
  });
});
