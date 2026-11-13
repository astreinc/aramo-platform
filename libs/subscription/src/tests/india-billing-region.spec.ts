import { describe, expect, it } from 'vitest';

import { isWebBillingProvider, WEB_BILLING_PROVIDERS } from '../lib/billing/billing-provider.port.js';
import { BILLING_GATEWAY_CONFIGURED, type BillingRegionView } from '../lib/billing/region/billing-region.view.js';
import { BillingRegionChangeError, BillingRegionService } from '../lib/billing/region/billing-region.service.js';
import { billingRegionChangeErrors, regionEnableRefusal, registrationErrors } from '../lib/billing/region/region-guard.js';
import {
  COMMERCIAL_ACTIONS,
  COMMERCIAL_ACTION_TYPES,
  CommercialPayloadError,
  canTransitionFor,
  isApplyExpirable,
  resolveRequiredChain,
  validatePayload,
} from '../lib/commercial/commercial-change-request.js';
import type { CommercialPolicyContent } from '../lib/commercial/commercial-policy.js';
import type { PrismaService } from '../lib/prisma/prisma.service.js';

// Aramo India Billing Regions + Razorpay Directive v1.0 (LOCKED) §4.1, §4.2, §5, §6, ruling Q3 — the
// provider key, the pure region rules (G-3, registration shape), the fail-closed sell decision and the
// governed BILLING_REGION_CHANGE write, against an in-memory region store.

const US_ENTITY = { id: '019a0000-0000-7000-8000-0000000a1e01', key: 'aramo-us', display_name: 'Aramo', legal_name: 'Aramo', country: 'US', active: true };
const IN_ENTITY = { id: '019a0000-0000-7000-8000-0000000a1e02', key: 'aramo-in', display_name: 'Aramo India', legal_name: 'Aramo India', country: 'IN', active: false };
const GSTIN = '27AAPFU0939F1ZV';

function view(patch: Partial<BillingRegionView> = {}): BillingRegionView {
  return {
    country: 'IN',
    gateway: 'RAZORPAY',
    currency: 'INR',
    enabled: false,
    personal_web_enabled: false,
    business_web_enabled: false,
    price_tax_mode: 'UNSET',
    selling_entity: { ...IN_ENTITY },
    ...patch,
  };
}

interface Row {
  country: string;
  gateway: string;
  currency: string;
  selling_entity_id: string;
  enabled: boolean;
  personal_web_enabled: boolean;
  business_web_enabled: boolean;
  price_tax_mode: string;
  updated_by: string | null;
}

/** The seeded state of migration 20261113100000, in memory. */
function store() {
  const entities = new Map<string, Record<string, unknown>>([
    [US_ENTITY.id, { ...US_ENTITY, registration: {} }],
    [IN_ENTITY.id, { ...IN_ENTITY, registration: {} }],
  ]);
  const regions = new Map<string, Row>([
    ['US', { country: 'US', gateway: 'STRIPE', currency: 'USD', selling_entity_id: US_ENTITY.id, enabled: true, personal_web_enabled: true, business_web_enabled: true, price_tax_mode: 'UNSET', updated_by: 'migration' }],
    ['IN', { country: 'IN', gateway: 'RAZORPAY', currency: 'INR', selling_entity_id: IN_ENTITY.id, enabled: false, personal_web_enabled: false, business_web_enabled: false, price_tax_mode: 'UNSET', updated_by: 'migration' }],
  ]);
  const withEntity = (r: Row) => ({ ...r, selling_entity: { ...entities.get(r.selling_entity_id) } });
  const db = {
    billingRegion: {
      findMany: async () => [...regions.values()].sort((a, b) => a.country.localeCompare(b.country)).map(withEntity),
      findUnique: async (a: { where: { country: string } }) => {
        const r = regions.get(a.where.country);
        return r === undefined ? null : withEntity(r);
      },
      update: async (a: { where: { country: string }; data: Partial<Row> }) => {
        const r = regions.get(a.where.country);
        if (r === undefined) throw new Error('not found');
        const { updated_at: _ignored, ...data } = a.data as Partial<Row> & { updated_at?: Date };
        Object.assign(r, data);
        return withEntity(r);
      },
    },
    sellingEntity: {
      update: async (a: { where: { id: string }; data: Record<string, unknown> }) => {
        const e = entities.get(a.where.id);
        if (e === undefined) throw new Error('not found');
        const { updated_at: _ignored, ...data } = a.data;
        Object.assign(e, data);
        return e;
      },
    },
    transactions: 0,
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      db.transactions += 1;
      return fn(db);
    },
  };
  return { db, regions, entities };
}

const svc = (db: unknown, configured?: (p: 'STRIPE' | 'RAZORPAY') => boolean) => new BillingRegionService(db as PrismaService, configured);
const allConfigured = () => true;

describe('India Billing §4.2 the provider key', () => {
  it('IB-P-1 the web billing providers are STRIPE and RAZORPAY; a store is never a web provider', () => {
    expect([...WEB_BILLING_PROVIDERS]).toEqual(['STRIPE', 'RAZORPAY']);
    expect(isWebBillingProvider('STRIPE')).toBe(true);
    expect(isWebBillingProvider('RAZORPAY')).toBe(true);
    for (const p of ['APP_STORE', 'GOOGLE_PLAY', 'stripe', '', null, undefined]) expect(isWebBillingProvider(p)).toBe(false);
  });
});

describe('India Billing §6 G-3 regionEnableRefusal (pure)', () => {
  it('IB-G-1 an unconfigured gateway is refused first', () => {
    expect(regionEnableRefusal(view({ price_tax_mode: 'INCLUSIVE', selling_entity: { ...IN_ENTITY, active: true } }), false)).toBe('gateway_not_configured');
    expect(regionEnableRefusal(view(), false)).toBe('gateway_not_configured');
  });
  it('IB-G-2 an inactive selling entity is refused', () => {
    expect(regionEnableRefusal(view({ price_tax_mode: 'INCLUSIVE' }), true)).toBe('selling_entity_inactive');
  });
  it('IB-G-3 a Razorpay region needs its price tax mode set (the C5 GST amendment)', () => {
    const active = { ...IN_ENTITY, active: true };
    expect(regionEnableRefusal(view({ selling_entity: active }), true)).toBe('price_tax_mode_unset');
    expect(regionEnableRefusal(view({ selling_entity: active, price_tax_mode: 'INCLUSIVE' }), true)).toBeNull();
    expect(regionEnableRefusal(view({ selling_entity: active, price_tax_mode: 'EXCLUSIVE' }), true)).toBeNull();
  });
  it('IB-G-4 a Stripe region keeps the existing CCP-C5 state (UNSET is not a refusal)', () => {
    expect(regionEnableRefusal(view({ country: 'US', gateway: 'STRIPE', currency: 'USD', selling_entity: { ...US_ENTITY } }), true)).toBeNull();
  });
});

describe('India Billing §5 registration and change shape (pure)', () => {
  it('IB-R-1 the named identifiers are accepted by shape', () => {
    expect(registrationErrors({})).toEqual([]);
    expect(registrationErrors({ gstin: GSTIN, pan: 'AAPFU0939F', state_code: '27', place_of_supply_rule: 'recipient_state', note: 'pending registration' })).toEqual([]);
  });
  it('IB-R-2 a malformed GSTIN or PAN, an unknown key, a non-string or untrimmed value, and a non-object are refused', () => {
    expect(registrationErrors({ gstin: '27AAPFU0939F1Z' })).toEqual(['registration.gstin must be a 15-character GSTIN']);
    expect(registrationErrors({ gstin: '27aapfu0939f1zv' })).toEqual(['registration.gstin must be a 15-character GSTIN']);
    expect(registrationErrors({ gstin: '27AAPFU0939F0ZV' })).toEqual(['registration.gstin must be a 15-character GSTIN']);
    expect(registrationErrors({ pan: 'AAPFU0939' })).toEqual(['registration.pan must be a 10-character PAN']);
    expect(registrationErrors({ vat: 'x' })[0]).toMatch(/^registration\.vat is not allowed/);
    expect(registrationErrors({ gstin: 15 })).toEqual(['registration.gstin must be a non-empty trimmed string']);
    expect(registrationErrors({ note: ' x' })).toEqual(['registration.note must be a non-empty trimmed string']);
    expect(registrationErrors({ note: 'x'.repeat(1001) })).toEqual(['registration.note is too long']);
    expect(registrationErrors([])).toEqual(['registration must be an object']);
    expect(registrationErrors(null)).toEqual(['registration must be an object']);
  });
  it('IB-R-3 a change has a closed key set, an ISO-2 country and at least one field', () => {
    expect(billingRegionChangeErrors({ country: 'IN', enabled: false })).toEqual([]);
    expect(billingRegionChangeErrors({ country: 'IN', selling_entity: { registration: { gstin: GSTIN } } })).toEqual([]);
    expect(billingRegionChangeErrors({ country: 'IN' })).toEqual(['the change names no field to change']);
    expect(billingRegionChangeErrors({ country: 'in', enabled: true })).toEqual(['country must be an ISO 3166-1 alpha-2 code']);
    expect(billingRegionChangeErrors({ country: 'IN', gateway: 'STRIPE', enabled: true })).toEqual(['gateway is not a field of this action']);
    expect(billingRegionChangeErrors({ country: 'IN', enabled: 'yes' })).toEqual(['enabled must be a boolean']);
    expect(billingRegionChangeErrors({ country: 'IN', price_tax_mode: 'GST' })).toEqual(['price_tax_mode must be one of UNSET, INCLUSIVE, EXCLUSIVE']);
    expect(billingRegionChangeErrors({ country: 'IN', selling_entity: { legal_name: '' } })).toEqual(['selling_entity.legal_name must be a non-empty trimmed string of at most 200 characters']);
    expect(billingRegionChangeErrors({ country: 'IN', selling_entity: { key: 'x' } })).toEqual(['selling_entity.key is not allowed', 'the change names no field to change']);
    expect(billingRegionChangeErrors({ country: 'IN', selling_entity: { registration: { gstin: 'bad' } } })).toEqual(['selling_entity.registration.gstin must be a 15-character GSTIN']);
  });
});

describe('India Billing Q3 BILLING_REGION_CHANGE action (catalog row 18)', () => {
  const policy = { approval_expiry_hours: 72 } as unknown as CommercialPolicyContent;
  it('IB-A-1 catalog, not tenant-scoped, requested through platform:catalog:draft; the closed set is 18', () => {
    expect(COMMERCIAL_ACTION_TYPES).toHaveLength(18);
    expect(COMMERCIAL_ACTION_TYPES[17]).toBe('BILLING_REGION_CHANGE');
    expect(COMMERCIAL_ACTIONS.BILLING_REGION_CHANGE).toEqual({ domain: 'catalog', tenant_scoped: false, requester_scope: 'platform:catalog:draft', requester_role: null });
  });
  it('IB-A-2 the chain is Finance (the ACTIVE policy chain), with the catalog approve scope', () => {
    const c = resolveRequiredChain('BILLING_REGION_CHANGE', { country: 'IN', enabled: true }, policy);
    expect(c.rule).toBe('FINANCE_ONLY');
    expect(c.steps).toEqual([{ step_index: 0, role_key: 'finance_admin', scope_keys: ['platform:catalog:approve'] }]);
  });
  it('IB-A-3 the A6 apply pairs and the AD-4 expiry', () => {
    expect(canTransitionFor('BILLING_REGION_CHANGE', 'APPROVED', 'APPLYING')).toBe(true);
    expect(canTransitionFor('BILLING_REGION_CHANGE', 'APPLY_FAILED', 'APPLYING')).toBe(true);
    expect(canTransitionFor('BILLING_REGION_CHANGE', 'APPLYING', 'APPLIED')).toBe(true);
    expect(canTransitionFor('BILLING_REGION_CHANGE', 'APPLYING', 'APPLY_FAILED')).toBe(true);
    expect(canTransitionFor('BILLING_REGION_CHANGE', 'APPROVED', 'APPLY_EXPIRED')).toBe(true);
    expect(canTransitionFor('BILLING_REGION_CHANGE', 'APPLYING', 'APPLY_EXPIRED')).toBe(false);
    expect(canTransitionFor('BILLING_REGION_CHANGE', 'DRAFT', 'APPLYING')).toBe(false);
    expect(isApplyExpirable('BILLING_REGION_CHANGE')).toBe(true);
  });
  it('IB-A-4 the payload is validated at create (closed shape, registration by shape)', () => {
    expect(validatePayload('BILLING_REGION_CHANGE', { country: 'IN', personal_web_enabled: true })).toEqual({ country: 'IN', personal_web_enabled: true });
    expect(() => validatePayload('BILLING_REGION_CHANGE', { country: 'IN', selling_entity: { registration: { gstin: 'x' } } })).toThrow(CommercialPayloadError);
    expect(() => validatePayload('BILLING_REGION_CHANGE', { country: 'IN' })).toThrow(CommercialPayloadError);
  });
});

describe('India Billing §6 BillingRegionService.sellable (fail closed)', () => {
  it('IB-S-1 the seeded US region sells both segments when Stripe is configured; the country is normalized', async () => {
    const { db } = store();
    const s = svc(db, (p) => p === 'STRIPE');
    const r = await s.sellable('us', 'PERSONAL');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.region).toMatchObject({ country: 'US', gateway: 'STRIPE', currency: 'USD', selling_entity: { key: 'aramo-us' } });
    expect((await s.sellable('US', 'BUSINESS')).ok).toBe(true);
  });
  it('IB-S-2 a null, malformed or unknown country is region_not_supported', async () => {
    const { db } = store();
    const s = svc(db, allConfigured);
    for (const c of [null, '', 'USA', '1N', 'DE']) expect(await s.sellable(c, 'PERSONAL'), String(c)).toEqual({ ok: false, reason: 'region_not_supported' });
  });
  it('IB-S-3 the seeded India region is region_disabled (G-1) even with Razorpay configured', async () => {
    const { db } = store();
    expect(await svc(db, allConfigured).sellable('IN', 'PERSONAL')).toEqual({ ok: false, reason: 'region_disabled' });
    expect(await svc(db, allConfigured).sellable('IN', 'BUSINESS')).toEqual({ ok: false, reason: 'region_disabled' });
  });
  it('IB-S-4 a segment switched off is segment_disabled', async () => {
    const { db, regions } = store();
    regions.get('US')!.business_web_enabled = false;
    expect(await svc(db, allConfigured).sellable('US', 'BUSINESS')).toEqual({ ok: false, reason: 'segment_disabled' });
    expect((await svc(db, allConfigured).sellable('US', 'PERSONAL')).ok).toBe(true);
  });
  it('IB-S-5 an unconfigured gateway is gateway_not_configured; with no binding no gateway is configured', async () => {
    const { db } = store();
    expect(await svc(db, () => false).sellable('US', 'PERSONAL')).toEqual({ ok: false, reason: 'gateway_not_configured' });
    expect(await svc(db).sellable('US', 'PERSONAL')).toEqual({ ok: false, reason: 'gateway_not_configured' });
    expect(
      await svc(db, () => {
        throw new Error('boom');
      }).sellable('US', 'PERSONAL'),
    ).toEqual({ ok: false, reason: 'gateway_not_configured' });
  });
  it('IB-S-6 a region left ON whose G-3 conditions no longer hold does not sell (entity inactive, Razorpay tax mode UNSET)', async () => {
    const { db, regions, entities } = store();
    Object.assign(regions.get('IN')!, { enabled: true, personal_web_enabled: true, price_tax_mode: 'INCLUSIVE' });
    expect(await svc(db, allConfigured).sellable('IN', 'PERSONAL')).toEqual({ ok: false, reason: 'region_disabled' });
    entities.get(IN_ENTITY.id)!['active'] = true;
    expect((await svc(db, allConfigured).sellable('IN', 'PERSONAL')).ok).toBe(true);
    regions.get('IN')!.price_tax_mode = 'UNSET';
    expect(await svc(db, allConfigured).sellable('IN', 'PERSONAL')).toEqual({ ok: false, reason: 'region_disabled' });
  });
  it('IB-S-7 a stored row outside the model (an unknown gateway) is region_not_supported', async () => {
    const { db, regions } = store();
    regions.get('US')!.gateway = 'PAYPAL';
    expect(await svc(db, allConfigured).sellable('US', 'PERSONAL')).toEqual({ ok: false, reason: 'region_not_supported' });
  });
  it('IB-S-8 list and get return the region views', async () => {
    const { db } = store();
    const s = svc(db, allConfigured);
    expect((await s.list()).map((r) => r.country)).toEqual(['IN', 'US']);
    expect(await s.get('xx')).toBeNull();
    expect((await s.get('in'))?.selling_entity).toEqual(IN_ENTITY);
  });
});

describe('India Billing Q3 BillingRegionService.applyChange (G-3 at write)', () => {
  const refusal = async (p: Promise<unknown>) => {
    try {
      await p;
      return null;
    } catch (e) {
      if (e instanceof BillingRegionChangeError) return e.reason;
      throw e;
    }
  };

  it('IB-W-1 turning India ON is refused while Razorpay is unconfigured, the entity inactive, or the tax mode UNSET', async () => {
    const { db, regions } = store();
    expect(await refusal(svc(db, (p) => p === 'STRIPE').applyChange({ country: 'IN', enabled: true }, 'op'))).toBe('gateway_not_configured');
    expect(await refusal(svc(db, allConfigured).applyChange({ country: 'IN', enabled: true }, 'op'))).toBe('selling_entity_inactive');
    expect(await refusal(svc(db, allConfigured).applyChange({ country: 'IN', enabled: true, selling_entity: { active: true } }, 'op'))).toBe('price_tax_mode_unset');
    // Nothing was written by a refused change.
    expect(regions.get('IN')).toMatchObject({ enabled: false, updated_by: 'migration' });
  });

  it('IB-W-2 with every G-3 condition met in one change, India turns ON; the entity and registration are written; updated_by is the actor', async () => {
    const { db, regions, entities } = store();
    const v = await svc(db, allConfigured).applyChange(
      { country: 'IN', enabled: true, personal_web_enabled: true, price_tax_mode: 'INCLUSIVE', selling_entity: { active: true, legal_name: 'Aramo India Private Limited', registration: { gstin: GSTIN } } },
      'operator-1',
    );
    expect(v).toMatchObject({ country: 'IN', enabled: true, personal_web_enabled: true, business_web_enabled: false, price_tax_mode: 'INCLUSIVE', selling_entity: { active: true, legal_name: 'Aramo India Private Limited' } });
    expect(regions.get('IN')!.updated_by).toBe('operator-1');
    expect(entities.get(IN_ENTITY.id)!['registration']).toEqual({ gstin: GSTIN });
    expect(db.transactions).toBe(1);
  });

  it('IB-W-3 switches may be set while the region is OFF, and turning a region OFF is never refused', async () => {
    const { db, regions } = store();
    await svc(db, () => false).applyChange({ country: 'IN', personal_web_enabled: true, business_web_enabled: true }, 'op');
    expect(regions.get('IN')).toMatchObject({ enabled: false, personal_web_enabled: true, business_web_enabled: true });
    await svc(db, () => false).applyChange({ country: 'US', enabled: false }, 'op');
    expect(regions.get('US')!.enabled).toBe(false);
  });

  it('IB-W-4 a change whose result is ON is G-3 checked even when it does not touch the master switch', async () => {
    const { db } = store();
    expect(await refusal(svc(db, () => false).applyChange({ country: 'US', business_web_enabled: false }, 'op'))).toBe('gateway_not_configured');
    expect(await refusal(svc(db, allConfigured).applyChange({ country: 'US', selling_entity: { active: false } }, 'op'))).toBe('selling_entity_inactive');
  });

  it('IB-W-5 an unknown region, an invalid shape and an empty actor are refused; a caller transaction is used as given', async () => {
    const { db } = store();
    expect(await refusal(svc(db, allConfigured).applyChange({ country: 'DE', enabled: false }, 'op'))).toBe('region_not_supported');
    expect(await refusal(svc(db, allConfigured).applyChange({ country: 'IN', selling_entity: { registration: { gstin: 'x' } } }, 'op'))).toBe('invalid_change');
    expect(await refusal(svc(db, allConfigured).applyChange({ country: 'IN', enabled: false }, ' '))).toBe('invalid_change');
    const before = db.transactions;
    await svc(db, allConfigured).applyChange({ country: 'IN', personal_web_enabled: true }, 'op', db as never);
    expect(db.transactions).toBe(before);
  });
});

describe('India Billing §4.1 module wiring', () => {
  it('IB-M-1 SubscriptionModule (and .forRoot()) provides BillingRegionService with the default gateway check (Stripe from the bound port, Razorpay unconfigured)', async () => {
    await import('reflect-metadata');
    const { Test } = await import('@nestjs/testing');
    const { SubscriptionModule } = await import('../lib/subscription.module.js');
    const env = { ...process.env };
    try {
      for (const mod of [SubscriptionModule, SubscriptionModule.forRoot()]) {
        const ref = await Test.createTestingModule({ imports: [mod] }).compile();
        expect(ref.get(BillingRegionService)).toBeInstanceOf(BillingRegionService);
        const configured = ref.get(BILLING_GATEWAY_CONFIGURED) as (p: string) => boolean;
        expect(configured('RAZORPAY')).toBe(false);
        expect(typeof configured('STRIPE')).toBe('boolean');
        await ref.close();
      }
    } finally {
      process.env = env;
    }
  });
});
