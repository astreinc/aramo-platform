import type { AuthContextType } from '@aramo/auth';
import type { IdentityRepository, OrganizationRegionService, PersonalSignupRepository, TenantRepository } from '@aramo/identity';
import { BillingRefusedError, BillingRegionService, StripeBillingProvider, type SubscriptionLifecycleService } from '@aramo/subscription';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BillingCountryAdapter } from '../app/billing/billing-country.adapter.js';
import { EsignBillingController, billingHttpError } from '../app/billing/esign-billing.controller.js';
import type { EsignOwnerActivationService } from '../app/billing/esign-owner-activation.service.js';
import { OrganizationBillingProfileAdapter } from '../app/billing/organization-billing-profile.adapter.js';
import type { PersonalSendGate } from '../app/personal/personal-send.gate.js';
import type { SenderContextService } from '../app/sender/sender-context.service.js';

// Aramo India Billing Regions + Razorpay Implementation Directive v1.0 (LOCKED) — WS-D, sign-service:
//   §4.4 / Q6   the routing country (BILLING_COUNTRY_PORT binding): Personal = declared residence,
//               Business = the organization's registered country.
//   §4.9        GET plans / the upgrade offer / checkout decide by the caller's region: US unchanged;
//               India OFF ⇒ nothing purchasable, checkout 409 personal_paid_us_only before the lifecycle
//               (HALT §8); India ON ⇒ the Razorpay catalog, INR display price, billing_gateway RAZORPAY.
//   §2          the Business organization profile is eligible in India only while India sells to BUSINESS.

type Row = {
  country: string;
  gateway: string;
  currency: string;
  enabled: boolean;
  personal_web_enabled: boolean;
  business_web_enabled: boolean;
  price_tax_mode: string;
  selling_entity: { id: string; key: string; display_name: string; legal_name: string; country: string; active: boolean };
};
const US_REGION: Row = {
  country: 'US', gateway: 'STRIPE', currency: 'USD', enabled: true, personal_web_enabled: true, business_web_enabled: true, price_tax_mode: 'UNSET',
  selling_entity: { id: 'e-us', key: 'aramo-us', display_name: 'Aramo', legal_name: 'Aramo', country: 'US', active: true },
};
const IN_OFF: Row = {
  country: 'IN', gateway: 'RAZORPAY', currency: 'INR', enabled: false, personal_web_enabled: false, business_web_enabled: false, price_tax_mode: 'UNSET',
  selling_entity: { id: 'e-in', key: 'aramo-in', display_name: 'Aramo India', legal_name: 'Aramo India', country: 'IN', active: false },
};
const IN_ON: Row = { ...IN_OFF, enabled: true, personal_web_enabled: true, business_web_enabled: true, price_tax_mode: 'INCLUSIVE', selling_entity: { ...IN_OFF.selling_entity, active: true } };

const regionStore = (rows: Row[]) =>
  new BillingRegionService({ billingRegion: { findUnique: async ({ where }: { where: { country: string } }) => rows.find((r) => r.country === where.country) ?? null } } as never, (() => true) as never);

const STANDARD = 'aramo-sign-standard-personal-v1';
const BUSINESS_PLAN = 'aramo-sign-standard-business-v1';
const OWNER = ['sign:billing:manage', 'sign:envelope:read'];
const auth = (): AuthContextType => ({ sub: 'u-owner', tenant_id: 't-1', scopes: OWNER, consumer_type: 'sign' }) as unknown as AuthContextType;

function setup(o: { kind: 'PERSONAL' | 'BUSINESS'; country: string | null; regions: Row[]; managedBy?: string | null }) {
  const lifecycle = {
    account: vi.fn(async () => ({
      subscription: o.managedBy === undefined ? null : { plan_key: STANDARD, plan_name: 'Standard', ended_at: null },
      allowance: { subscribed: true, limit: 5 },
      billing_available: true,
      tax: { enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' },
    })),
    sendingOwner: vi.fn(async () => null),
    tenantActivationState: vi.fn(async () => null),
    catalog: vi.fn(async () => [
      { key: STANDARD, tenant_kind: 'PERSONAL', sales_model: 'SELF_SERVICE', price: { amount_minor: 1000, currency: 'USD', interval: 'MONTH' }, commitment_months: 12, purchasable: true },
      { key: BUSINESS_PLAN, tenant_kind: 'BUSINESS', sales_model: 'SELF_SERVICE', price: { amount_minor: 1500, currency: 'USD', interval: 'MONTH' }, commitment_months: null, purchasable: true },
    ]),
    startCheckout: vi.fn(async () => ({ url: 'https://rzp.io/i/sub_1' })),
  } as unknown as SubscriptionLifecycleService;
  const tenant = { id: 't-1', kind: o.kind, status: 'ACTIVE' };
  const ctx = {
    tenantKind: vi.fn(async () => o.kind),
    tenantOf: vi.fn(async () => tenant),
    personalAuthoringOpen: vi.fn(() => o.kind === 'PERSONAL'),
    assertCanAuthorTenant: vi.fn(async () => tenant),
  } as unknown as SenderContextService;
  const personal = { ensureFreeSubscription: vi.fn(async () => undefined) } as unknown as PersonalSendGate;
  const identity = { findUserById: vi.fn(async () => ({ id: 'u-owner', email: 'me@example.test' })) } as unknown as IdentityRepository;
  const owners = { activate: vi.fn(async () => 'ALREADY') } as unknown as EsignOwnerActivationService;
  const signups = { declaredResidenceOf: vi.fn(async () => o.country) } as unknown as PersonalSignupRepository;
  const store = {
    enabled: vi.fn(() => false),
    accountView: vi.fn(async () => ({ managed_by: o.managedBy ?? null, store_purchase_eligible: false, store_purchase_block_reason: 'store_billing_disabled', manage_url: null })),
    planOffers: vi.fn(async (_p: string, country: string | null) =>
      new Map(
        country === 'IN'
          ? [
              [STANDARD, { store_products: [], regional_prices: [{ country: 'IN', currency: 'INR', amount_minor: 89900, interval: 'MONTH' }] }],
              [BUSINESS_PLAN, { store_products: [], regional_prices: [{ country: 'IN', currency: 'INR', amount_minor: 149900, interval: 'MONTH' }] }],
            ]
          : [],
      ),
    ),
  };
  const countries = { countryOf: vi.fn(async () => ({ tenant_kind: o.kind, country: o.country })) } as unknown as BillingCountryAdapter;
  const controller = new EsignBillingController(
    lifecycle, new StripeBillingProvider(), owners, ctx, identity, personal, undefined, undefined, signups, undefined, store as never, undefined, undefined,
    regionStore(o.regions), countries,
  );
  return { controller, lifecycle };
}

type PlansOut = { plans: Array<Record<string, unknown>>; billing_gateway: string; billing_currency: string };

describe('India Billing — GET plans, the upgrade offer and checkout route by the caller region', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env['SIGN_PERSONAL_PAID_CHECKOUT_ENABLED'] = '1';
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('US Personal: unchanged — Stripe catalog, USD, display_price = price, purchasable', async () => {
    const { controller, lifecycle } = setup({ kind: 'PERSONAL', country: 'US', regions: [US_REGION, IN_OFF] });
    const out = (await controller.plans(auth(), 'r')) as PlansOut;
    expect(lifecycle.catalog).toHaveBeenCalledWith('sign', 't-1', 'PERSONAL', 'STRIPE');
    expect(out).toMatchObject({ billing_gateway: 'STRIPE', billing_currency: 'USD' });
    expect(out.plans[0]).toMatchObject({ key: STANDARD, purchasable: true, display_price: { amount_minor: 1000, currency: 'USD', interval: 'MONTH' } });
  });

  it('HALT §8 — India OFF: an India resident sees nothing purchasable, the offer is unavailable, checkout 409 before the lifecycle', async () => {
    const { controller, lifecycle } = setup({ kind: 'PERSONAL', country: 'IN', regions: [US_REGION, IN_OFF] });
    const out = (await controller.plans(auth(), 'r')) as PlansOut;
    expect(out.plans.find((p) => p['key'] === STANDARD)).toMatchObject({ purchasable: false });
    expect(out.billing_gateway).toBe('STRIPE');
    const account = (await controller.account(auth(), 'r')) as Record<string, unknown>;
    expect(account['upgrade']).toMatchObject({ available: false, reason: 'not_available_in_country' });
    await expect(controller.checkout(auth(), 'r', { plan_key: STANDARD, accept_terms: true })).rejects.toMatchObject({ statusCode: 409, context: { details: { reason: 'personal_paid_us_only' } } });
    expect(lifecycle.startCheckout).not.toHaveBeenCalled();
  });

  it('India ON: the Razorpay catalog, INR display price and billing_gateway RAZORPAY; checkout reaches the lifecycle', async () => {
    const { controller, lifecycle } = setup({ kind: 'PERSONAL', country: 'IN', regions: [US_REGION, IN_ON] });
    const out = (await controller.plans(auth(), 'r')) as PlansOut;
    expect(lifecycle.catalog).toHaveBeenCalledWith('sign', 't-1', 'PERSONAL', 'RAZORPAY');
    expect(out).toMatchObject({ billing_gateway: 'RAZORPAY', billing_currency: 'INR' });
    expect(out.plans.find((p) => p['key'] === STANDARD)).toMatchObject({ purchasable: true, display_price: { amount_minor: 89900, currency: 'INR', interval: 'MONTH' } });
    const account = (await controller.account(auth(), 'r')) as Record<string, unknown>;
    expect(account['upgrade']).toMatchObject({ available: true, price_minor: 89900, currency: 'INR', billing_gateway: 'RAZORPAY' });
    expect(await controller.checkout(auth(), 'r', { plan_key: STANDARD, accept_terms: true })).toEqual({ url: 'https://rzp.io/i/sub_1' });
  });

  it('Business: India OFF ⇒ not purchasable; US unchanged; a country not yet entered keeps today’s behaviour', async () => {
    const off = (await setup({ kind: 'BUSINESS', country: 'IN', regions: [US_REGION, IN_OFF] }).controller.plans(auth(), 'r')) as PlansOut;
    expect(off.plans.find((p) => p['key'] === BUSINESS_PLAN)).toMatchObject({ purchasable: false });
    const us = (await setup({ kind: 'BUSINESS', country: 'US', regions: [US_REGION, IN_OFF] }).controller.plans(auth(), 'r')) as PlansOut;
    expect(us.plans.find((p) => p['key'] === BUSINESS_PLAN)).toMatchObject({ purchasable: true, display_price: { amount_minor: 1500, currency: 'USD' } });
    const none = (await setup({ kind: 'BUSINESS', country: null, regions: [US_REGION, IN_OFF] }).controller.plans(auth(), 'r')) as PlansOut;
    expect(none.plans.find((p) => p['key'] === BUSINESS_PLAN)).toMatchObject({ purchasable: true });
    const on = (await setup({ kind: 'BUSINESS', country: 'IN', regions: [US_REGION, IN_ON] }).controller.plans(auth(), 'r')) as PlansOut;
    expect(on).toMatchObject({ billing_gateway: 'RAZORPAY', billing_currency: 'INR' });
    expect(on.plans.find((p) => p['key'] === BUSINESS_PLAN)).toMatchObject({ purchasable: true, display_price: { amount_minor: 149900, currency: 'INR' } });
  });

  it('GET account: a Razorpay-billed plan carries its INR display price; a Stripe one none', async () => {
    const rzp = (await setup({ kind: 'PERSONAL', country: 'IN', regions: [US_REGION, IN_ON], managedBy: 'RAZORPAY' }).controller.account(auth(), 'r')) as Record<string, unknown>;
    expect(rzp['display_price']).toEqual({ amount_minor: 89900, currency: 'INR', interval: 'MONTH' });
    expect(rzp['managed_by']).toBe('RAZORPAY');
    const stripe = (await setup({ kind: 'PERSONAL', country: 'US', regions: [US_REGION, IN_ON], managedBy: 'STRIPE' }).controller.account(auth(), 'r')) as Record<string, unknown>;
    expect(stripe['display_price']).toBeNull();
  });

  it('BILLING_REGION_NOT_SELLABLE maps to the existing 409 personal_paid_us_only', () => {
    const e = billingHttpError(new BillingRefusedError('BILLING_REGION_NOT_SELLABLE', 'region_disabled'), 'r');
    expect(e).toMatchObject({ statusCode: 409, code: 'ESIGN_BILLING_CONFLICT', context: { details: { reason: 'personal_paid_us_only' } } });
  });
});

describe('India Billing §4.4 — BillingCountryAdapter (BILLING_COUNTRY_PORT)', () => {
  const adapter = (kind: string | null, residence: string | null, country_code: string | null) =>
    new BillingCountryAdapter(
      { findById: vi.fn(async () => (kind === null ? null : { id: 't-1', kind })), findProfileById: vi.fn(async () => ({ country_code })) } as unknown as TenantRepository,
      { declaredResidenceOf: vi.fn(async () => residence) } as unknown as PersonalSignupRepository,
    );

  it('Personal → the declared residence; Business → the registered country; anything malformed or missing → null', async () => {
    expect(await adapter('PERSONAL', 'in', 'US').countryOf('t-1')).toEqual({ tenant_kind: 'PERSONAL', country: 'IN' });
    expect(await adapter('BUSINESS', 'IN', ' us ').countryOf('t-1')).toEqual({ tenant_kind: 'BUSINESS', country: 'US' });
    expect(await adapter('BUSINESS', null, null).countryOf('t-1')).toEqual({ tenant_kind: 'BUSINESS', country: null });
    expect(await adapter('PERSONAL', 'India', null).countryOf('t-1')).toEqual({ tenant_kind: 'PERSONAL', country: null });
    expect(await adapter(null, 'US', 'US').countryOf('t-1')).toEqual({ tenant_kind: null, country: null });
  });
});

describe('India Billing §2 — the Business organization profile in India', () => {
  const IN_PROFILE = {
    id: 't-1', name: 'Acme', legal_name: 'Acme India Pvt Ltd', display_name: null, address_line1: '1 MG Road', address_line2: null, city: 'Bengaluru', state_province: 'Karnataka',
    postal_code: '560001', country_code: 'IN', tax_id: null, registration_number: null, primary_contact_name: 'Pat', primary_contact_email: 'billing@acme.test', primary_contact_phone: null, logo_url: null, updated_at: new Date(0),
  };
  const adapter = (rows: Row[] | null) => {
    const regions = { lockUs: vi.fn(async () => undefined), lock: vi.fn(async () => undefined) };
    const a = new OrganizationBillingProfileAdapter({ findProfileById: vi.fn(async () => IN_PROFILE) } as unknown as TenantRepository, regions as unknown as OrganizationRegionService, undefined, rows === null ? undefined : regionStore(rows));
    return { a, regions };
  };

  it('refused while India does not sell to BUSINESS (OFF, or no region store); eligible once ON', async () => {
    expect(await adapter([US_REGION, IN_OFF]).a.eligibleProfile('t-1')).toEqual({ refused: 'organization_country_not_supported' });
    expect(await adapter(null).a.eligibleProfile('t-1')).toEqual({ refused: 'organization_country_not_supported' });
    expect(await adapter([US_REGION, IN_ON]).a.eligibleProfile('t-1')).toMatchObject({ profile: { address: { country: 'IN', postal_code: '560001', state: 'KARNATAKA' } } });
  });

  it('holds the profile to the routed region (US through lockUs exactly as before)', async () => {
    const { a, regions } = adapter([US_REGION, IN_ON]);
    await a.lockRegion('t-1', 'IN');
    await a.lockRegion('t-2', 'US');
    await a.lockRegion('t-3');
    expect(regions.lock).toHaveBeenCalledWith('t-1', 'IN');
    expect(regions.lockUs.mock.calls).toEqual([['t-2'], ['t-3']]);
  });
});
