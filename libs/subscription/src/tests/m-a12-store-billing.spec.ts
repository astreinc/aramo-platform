import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderSubscriptionState } from '../lib/billing/billing-provider.port.js';
import { StoreVerificationError } from '../lib/billing/store/store-billing.port.js';
import { StoreBillingRefusedError, StoreBillingService, type StoreCaller, storePurchaseBlock } from '../lib/billing/store/store-billing.service.js';
import { reconcileStorePrices } from '../lib/billing/store/store-price-reconciliation.js';
import { planVersionChecksum, planVersionContentFromRows } from '../lib/plan-version.js';

// Aramo Sign Mobile M-A12 §4 item 4 (with Amendment A1-2) — the store purchase rules of
// StoreBillingService against in-memory fakes of the database, the lifecycle and both store adapters:
// the disabled flag, billing authority, the one-member rule (multi-seat Business → 409), Stripe and
// governed coexistence (→ 409 billing_managed_elsewhere), the product of the caller's kind only,
// bound elsewhere (→ 409), unverifiable purchases (→ 422), idempotent replay, the Google account id
// and acknowledgement, the notifications into the inbox (re-fetched there), and the account view.
// The lifecycle's own store application (status mapping, Free fallback) runs on real Postgres in
// m-a12-store-lifecycle.integration.spec.ts.

const T1 = '019a1200-0000-7000-8000-0000000000a1';
const T2 = '019a1200-0000-7000-8000-0000000000a2';
const U1 = '019a1200-0000-7000-8000-0000000000b1';
const BUSINESS_PLAN = '019a1200-0000-7000-8000-0000000000c1';
const PERSONAL_PLAN = '019a1200-0000-7000-8000-0000000000c2';
const V_BUSINESS = '019a1200-0000-7000-8000-0000000000d1';
const V_PERSONAL = '019a1200-0000-7000-8000-0000000000d2';

type Row = Record<string, unknown> & { id: string; tenant_id: string; source: string; billing_provider: string | null; billing_subscription_ref: string | null; ended_at: Date | null; store_product_id?: string | null };

function content(kind: 'BUSINESS' | 'PERSONAL', regional = false) {
  const c = planVersionContentFromRows({
    plan: { key: `p-${kind}`, product_key: 'sign', name: kind, description: null, tenant_kind: kind, sales_model: 'SELF_SERVICE', list_price_minor: 1500, currency: 'USD', reference_price_minor: null, reference_price_substantiated: false, billing_interval: 'MONTH', commitment_months: 12, eligibility: null, support_tier: null },
    allowances: [],
    allowance_windows: [],
    capacities: [],
    features: [],
  });
  return regional ? { ...c, regional_prices: [{ country: 'IN', currency: 'INR', amount_minor: 89900, interval: 'MONTH' }, { country: 'IN', currency: 'INR', amount_minor: 899900, interval: 'YEAR' }] } : c;
}

class FakeDb {
  subs: Row[] = [];
  intents: { id: string; tenant_id: string; user_id: string; plan_id: string; provider: string; store_product_id: string }[] = [];
  plans = [
    { id: BUSINESS_PLAN, key: 'p-BUSINESS', tenant_kind: 'BUSINESS', status: 'ACTIVE', sales_model: 'SELF_SERVICE', sellable: true, product_key: 'sign' },
    { id: PERSONAL_PLAN, key: 'p-PERSONAL', tenant_kind: 'PERSONAL', status: 'ACTIVE', sales_model: 'SELF_SERVICE', sellable: true, product_key: 'sign' },
  ];
  versions = [
    { id: V_BUSINESS, plan_id: BUSINESS_PLAN, status: 'PUBLISHED', version_number: 1, content: content('BUSINESS', true) },
    { id: V_PERSONAL, plan_id: PERSONAL_PLAN, status: 'PUBLISHED', version_number: 1, content: content('PERSONAL') },
  ];
  pins = [
    { plan_version_id: V_BUSINESS, provider: 'APP_STORE', provider_price_ref: 'ai.aramo.sign.business.monthly', interval: 'MONTH' },
    { plan_version_id: V_BUSINESS, provider: 'GOOGLE_PLAY', provider_price_ref: 'ai.aramo.sign.business.annual', interval: 'YEAR' },
    { plan_version_id: V_PERSONAL, provider: 'APP_STORE', provider_price_ref: 'ai.aramo.sign.standard.monthly', interval: 'MONTH' },
  ];
  private version(id: string) {
    const v = this.versions.find((x) => x.id === id)!;
    const plan = this.plans.find((p) => p.id === v.plan_id)!;
    return { ...v, content_checksum: planVersionChecksum(v.content), plan };
  }
  tenantSubscription = {
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      this.subs.find(
        (r) =>
          (where['tenant_id'] === undefined || r.tenant_id === where['tenant_id']) &&
          (!('ended_at' in where) || r.ended_at === null) &&
          (where['billing_provider'] === undefined || r.billing_provider === where['billing_provider']) &&
          (where['billing_subscription_ref'] === undefined || r.billing_subscription_ref === where['billing_subscription_ref']),
      ) ?? null,
    count: async ({ where }: { where: Record<string, unknown> }) => this.subs.filter((r) => r.tenant_id === where['tenant_id'] && r.billing_provider === where['billing_provider'] && r.billing_subscription_ref === where['billing_subscription_ref']).length,
  };
  checkoutIntent = {
    findUnique: async ({ where }: { where: { id: string } }) => this.intents.find((i) => i.id === where.id) ?? null,
    create: async ({ data }: { data: FakeDb['intents'][number] }) => {
      this.intents.push(data);
      return data;
    },
  };
  plan = { findUnique: async ({ where }: { where: { id: string } }) => this.plans.find((p) => p.id === where.id) ?? null };
  planVersion = {
    findMany: async () => this.versions.map((v) => ({ ...this.version(v.id), plan: { key: this.version(v.id).plan.key } })),
  };
  planVersionPrice = {
    findMany: async ({ where }: { where: Record<string, unknown> }) => {
      const provider = where['provider'];
      const ref = where['provider_price_ref'];
      const ver = where['plan_version_id'];
      return this.pins
        .filter((p) => (typeof provider === 'string' ? p.provider === provider : provider === undefined || (provider as { in: string[] }).in.includes(p.provider)) && (ref === undefined || p.provider_price_ref === ref) && (ver === undefined || p.plan_version_id === ver))
        .map((p) => ({ ...p, plan_version: this.version(p.plan_version_id) }));
    },
  };
  $executeRaw = async () => 0;
  $transaction = async <T>(fn: (tx: FakeDb) => Promise<T>) => fn(this);
}

/** The lifecycle's provider-state application, faked: open on first sight, update after (idempotent on the ref). */
function fakeLifecycle(db: FakeDb) {
  return {
    applyProviderState: vi.fn(async (state: ProviderSubscriptionState) => {
      const existing = db.subs.find((r) => r.billing_provider === state.provider && r.billing_subscription_ref === state.subscription_ref);
      const intent = db.intents.find((i) => i.id === state.intent_id);
      const tenant_id = existing?.tenant_id ?? intent?.tenant_id ?? null;
      if (tenant_id === null) return { outcome: 'IGNORED' as const, detail: 'unlinked', tenant_id: null };
      if (existing !== undefined) return { outcome: 'APPLIED' as const, detail: 'ACTIVE -> ACTIVE', tenant_id, subscription_id: existing.id };
      const id = `sub-${String(db.subs.length + 1)}`;
      db.subs.push({ id, tenant_id, source: 'SELF_SERVICE', billing_provider: state.provider, billing_subscription_ref: state.subscription_ref, ended_at: null, store_product_id: state.store?.product_id ?? null });
      return { outcome: 'APPLIED' as const, detail: 'opened ACTIVE', tenant_id, subscription_id: id, activated_owner_user_id: U1 };
    }),
    handleEvent: vi.fn(async () => ({ outcome: 'APPLIED' as const, tenant_id: T1 })),
  };
}

const appleState = (ref: string, token: string | null, product = 'ai.aramo.sign.business.monthly'): ProviderSubscriptionState => ({
  provider: 'APP_STORE',
  subscription_ref: ref,
  account_ref: '',
  provider_status: 'active',
  current_period_start: new Date('2026-11-01T00:00:00Z'),
  current_period_end: new Date('2026-12-01T00:00:00Z'),
  cancel_at_period_end: false,
  price_ref: product,
  tenant_id: null,
  intent_id: token,
  account_country: null,
  store: { product_id: product, environment: 'Sandbox', grace_until: null },
});

function setup(opts: { members?: number; domain?: boolean } = {}) {
  const db = new FakeDb();
  const lifecycle = fakeLifecycle(db);
  const apple = {
    isConfigured: () => true,
    tx: new Map<string, { original_transaction_id: string; transaction_id: string; product_id: string; app_account_token: string | null; environment: 'Sandbox' }>(),
    verifyTransaction: vi.fn(async function (this: void, jws: string) {
      const t = apple.tx.get(jws);
      if (t === undefined) throw new StoreVerificationError('jws_bad_chain');
      return t;
    }),
    retrieveSubscription: vi.fn(async (ref: string) => {
      const t = [...apple.tx.values()].find((x) => x.original_transaction_id === ref)!;
      return appleState(ref, t.app_account_token, t.product_id);
    }),
    verifyNotification: vi.fn(async () => ({ provider: 'APP_STORE' as const, id: 'n-1', type: 'DID_RENEW', created: new Date(), subscription_ref: '2000000100' })),
  };
  const google = {
    isConfigured: () => true,
    pushConfigured: () => true,
    packageName: 'ai.aramo.sign',
    purchases: new Map<string, Record<string, unknown>>(),
    getPurchase: vi.fn(async (token: string) => {
      const p = google.purchases.get(token);
      if (p === undefined) throw new StoreVerificationError('unknown_purchase');
      return p;
    }),
    acknowledge: vi.fn(async () => undefined),
    verifyPush: vi.fn(async () => null),
  };
  const members = { activeMemberCount: vi.fn(async () => opts.members ?? 1) };
  const inbox = { receive: vi.fn(async () => ({ outcome: 'APPLIED' as const, tenant_id: T1 })) };
  const orgProfile = { domainAuthoritative: vi.fn(async () => opts.domain ?? true) };
  const svc = new StoreBillingService(db as never, lifecycle as never, apple as never, google as never, members, inbox as never, orgProfile as never);
  return { db, lifecycle, apple, google, members, inbox, svc };
}

const business: StoreCaller = { tenant_id: T1, user_id: U1, tenant_kind: 'BUSINESS', can_manage: true, personal_open: false };
const personal: StoreCaller = { tenant_id: T1, user_id: U1, tenant_kind: 'PERSONAL', can_manage: true, personal_open: true };

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'NOT_REFUSED';
  } catch (e) {
    if (e instanceof StoreBillingRefusedError) return `${e.status} ${e.reason}${e.detail !== undefined ? ` ${e.detail}` : ''}`;
    throw e;
  }
}

describe('M-A12 — storePurchaseBlock (A1-2, W1-G item 5): who may buy in the app', () => {
  const base = { enabled: true, can_manage: true, tenant_kind: 'BUSINESS', personal_open: false, open: null, active_members: 1 };
  it('in order: disabled, not the billing manager, managed elsewhere, seats', () => {
    expect(storePurchaseBlock(base)).toBeNull();
    expect(storePurchaseBlock({ ...base, enabled: false, can_manage: false })).toBe('store_billing_disabled');
    expect(storePurchaseBlock({ ...base, can_manage: false })).toBe('not_billing_manager');
    expect(storePurchaseBlock({ ...base, tenant_kind: 'PERSONAL', personal_open: false })).toBe('not_billing_manager');
    expect(storePurchaseBlock({ ...base, open: { source: 'SELF_SERVICE', billing_provider: 'STRIPE' } })).toBe('billing_managed_elsewhere');
    expect(storePurchaseBlock({ ...base, open: { source: 'MANUAL', billing_provider: null } })).toBe('billing_managed_elsewhere');
    expect(storePurchaseBlock({ ...base, active_members: 2 })).toBe('store_purchase_seats_unsupported');
    expect(storePurchaseBlock({ ...base, active_members: null })).toBe('store_purchase_seats_unsupported');
  });
  it('India Billing §4.8: an open Razorpay (web) subscription is managed elsewhere, like Stripe', () => {
    expect(storePurchaseBlock({ ...base, open: { source: 'SELF_SERVICE', billing_provider: 'RAZORPAY' } })).toBe('billing_managed_elsewhere');
  });
  it('an open FREE, DEVELOPMENT or store subscription does not block (upgrade / change in the store)', () => {
    expect(storePurchaseBlock({ ...base, open: { source: 'FREE', billing_provider: null } })).toBeNull();
    expect(storePurchaseBlock({ ...base, open: { source: 'DEVELOPMENT', billing_provider: null } })).toBeNull();
    expect(storePurchaseBlock({ ...base, open: { source: 'SELF_SERVICE', billing_provider: 'APP_STORE' } })).toBeNull();
  });
});

describe('M-A12 — StoreBillingService', () => {
  beforeEach(() => vi.stubEnv('SIGN_STORE_BILLING_ENABLED', '1'));
  afterEach(() => vi.unstubAllEnvs());

  describe('intent', () => {
    it('the disabled flag → 503 store_billing_disabled (no intent)', async () => {
      vi.stubEnv('SIGN_STORE_BILLING_ENABLED', '');
      const h = setup();
      expect(await refusal(h.svc.createIntent(business, 'sign', { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly' }))).toBe('503 store_billing_disabled');
      expect(h.db.intents).toHaveLength(0);
    });

    it('issues a tenant-bound token: app_account_token = intent_id; the intent records the store and product', async () => {
      const h = setup();
      const out = await h.svc.createIntent(business, 'sign', { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly' });
      expect(out.app_account_token).toBe(out.intent_id);
      expect(h.db.intents).toEqual([{ id: out.intent_id, tenant_id: T1, user_id: U1, plan_id: BUSINESS_PLAN, provider: 'APP_STORE', store_product_id: 'ai.aramo.sign.business.monthly' }]);
    });

    it('multi-seat Business → 409 store_purchase_seats_unsupported', async () => {
      const h = setup({ members: 2 });
      expect(await refusal(h.svc.createIntent(business, 'sign', { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly' }))).toBe('409 store_purchase_seats_unsupported');
    });

    it('Stripe coexistence: an open Stripe subscription → 409 billing_managed_elsewhere; a governed one too', async () => {
      const h = setup();
      h.db.subs.push({ id: 's', tenant_id: T1, source: 'SELF_SERVICE', billing_provider: 'STRIPE', billing_subscription_ref: 'sub_1', ended_at: null });
      expect(await refusal(h.svc.createIntent(business, 'sign', { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly' }))).toBe('409 billing_managed_elsewhere');
      h.db.subs = [{ id: 'm', tenant_id: T1, source: 'MANUAL', billing_provider: null, billing_subscription_ref: null, ended_at: null }];
      expect(await refusal(h.svc.createIntent(business, 'sign', { platform: 'android', product_id: 'ai.aramo.sign.business.annual' }))).toBe('409 billing_managed_elsewhere');
    });

    it('India Billing §4.8: an open Razorpay subscription → 409 billing_managed_elsewhere (intent and verify)', async () => {
      const h = setup();
      h.db.subs.push({ id: 'r', tenant_id: T1, source: 'SELF_SERVICE', billing_provider: 'RAZORPAY', billing_subscription_ref: 'sub_rzp_1', ended_at: null });
      expect(await refusal(h.svc.createIntent(business, 'sign', { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly' }))).toBe('409 billing_managed_elsewhere');
      expect(await refusal(h.svc.verify(business, 'sign', { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly', intent_id: '019a1200-0000-7000-8000-0000000000ff', signed_transaction: 'jws-good' }))).toBe('409 billing_managed_elsewhere');
      expect(h.db.intents).toHaveLength(0);
    });

    it('A5: a PERSONAL tenant buys a Personal product only, a BUSINESS tenant never a Personal one; unknown products are refused', async () => {
      const h = setup();
      expect(await refusal(h.svc.createIntent(personal, 'sign', { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly' }))).toBe('409 store_product_not_available');
      expect(await refusal(h.svc.createIntent(business, 'sign', { platform: 'ios', product_id: 'ai.aramo.sign.standard.monthly' }))).toBe('409 store_product_not_available');
      expect(await refusal(h.svc.createIntent(business, 'sign', { platform: 'ios', product_id: 'ai.aramo.sign.unknown' }))).toBe('409 store_product_not_available');
      expect((await h.svc.createIntent(personal, 'sign', { platform: 'ios', product_id: 'ai.aramo.sign.standard.monthly' })).intent_id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('a member without billing authority → 403 not_billing_manager; a Business domain not yet verified → 409', async () => {
      expect(await refusal(setup().svc.createIntent({ ...business, can_manage: false }, 'sign', { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly' }))).toBe('403 not_billing_manager');
      expect(await refusal(setup({ domain: false }).svc.createIntent(business, 'sign', { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly' }))).toBe('409 domain_verification_required');
    });
  });

  describe('verify (iOS)', () => {
    async function purchased(h: ReturnType<typeof setup>, caller = business) {
      const { intent_id } = await h.svc.createIntent(caller, 'sign', { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly' });
      h.apple.tx.set('jws-good', { original_transaction_id: '2000000100', transaction_id: '2000000111', product_id: 'ai.aramo.sign.business.monthly', app_account_token: intent_id, environment: 'Sandbox' });
      return intent_id;
    }

    it('applies the state RE-FETCHED from the App Store Server API; an idempotent replay opens nothing new', async () => {
      const h = setup();
      const intent_id = await purchased(h);
      const input = { platform: 'ios' as const, product_id: 'ai.aramo.sign.business.monthly', intent_id, signed_transaction: 'jws-good' };
      expect(await h.svc.verify(business, 'sign', input)).toMatchObject({ outcome: 'APPLIED', tenant_id: T1, activated_owner_user_id: U1 });
      expect(h.apple.retrieveSubscription).toHaveBeenCalledWith('2000000100');
      expect(await h.svc.verify(business, 'sign', input)).toMatchObject({ outcome: 'APPLIED', tenant_id: T1 });
      expect(h.db.subs.filter((r) => r.billing_subscription_ref === '2000000100')).toHaveLength(1);
    });

    it('an unverifiable signed transaction → 422 store_purchase_invalid (the reason, never the payload)', async () => {
      const h = setup();
      const intent_id = await purchased(h);
      expect(await refusal(h.svc.verify(business, 'sign', { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly', intent_id, signed_transaction: 'jws-forged' }))).toBe('422 store_purchase_invalid jws_bad_chain');
      expect(h.lifecycle.applyProviderState).not.toHaveBeenCalled();
    });

    it('a product other than the one verified → 422', async () => {
      const h = setup();
      const intent_id = await purchased(h);
      expect(await refusal(h.svc.verify(business, 'sign', { platform: 'ios', product_id: 'ai.aramo.sign.business.annual', intent_id, signed_transaction: 'jws-good' }))).toBe('422 store_purchase_invalid product_mismatch');
    });

    it('bound elsewhere: a transaction whose appAccountToken is another tenant’s → 409; a store ref held by another tenant → 409', async () => {
      const h = setup();
      await purchased(h);
      const other = { ...business, tenant_id: T2 };
      const { intent_id } = await h.svc.createIntent(other, 'sign', { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly' });
      expect(await refusal(h.svc.verify(other, 'sign', { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly', intent_id, signed_transaction: 'jws-good' }))).toBe('409 store_purchase_bound_elsewhere');
      h.db.subs.push({ id: 'x', tenant_id: T2, source: 'SELF_SERVICE', billing_provider: 'APP_STORE', billing_subscription_ref: '2000000100', ended_at: null });
      expect(await refusal(h.svc.verify(business, 'sign', { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly', intent_id, signed_transaction: 'jws-good' }))).toBe('409 store_purchase_bound_elsewhere');
    });

    it('Stripe coexistence at verify → 409 billing_managed_elsewhere (nothing applied)', async () => {
      const h = setup();
      const intent_id = await purchased(h);
      h.db.subs.push({ id: 's', tenant_id: T1, source: 'SELF_SERVICE', billing_provider: 'STRIPE', billing_subscription_ref: 'sub_1', ended_at: null });
      expect(await refusal(h.svc.verify(business, 'sign', { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly', intent_id, signed_transaction: 'jws-good' }))).toBe('409 billing_managed_elsewhere');
      expect(h.lifecycle.applyProviderState).not.toHaveBeenCalled();
    });

    it('restore applies each bound transaction (at most 10)', async () => {
      const h = setup();
      await purchased(h);
      expect(await h.svc.restore(business, 'sign', { platform: 'ios', signed_transactions: ['jws-good'] })).toEqual([expect.objectContaining({ outcome: 'APPLIED', tenant_id: T1 })]);
    });
  });

  describe('verify (Android)', () => {
    const play = (intent: string, over: Record<string, unknown> = {}) => ({
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
      startTime: '2026-11-01T00:00:00Z',
      acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
      externalAccountIdentifiers: { obfuscatedExternalAccountId: intent },
      lineItems: [{ productId: 'ai.aramo.sign.business.annual', expiryTime: '2027-11-01T00:00:00Z', autoRenewingPlan: { autoRenewEnabled: true } }],
      ...over,
    });

    it('applies the subscriptionsv2 state and acknowledges an unacknowledged purchase (once)', async () => {
      const h = setup();
      const { intent_id } = await h.svc.createIntent(business, 'sign', { platform: 'android', product_id: 'ai.aramo.sign.business.annual' });
      h.google.purchases.set('tok-1', play(intent_id));
      expect(await h.svc.verify(business, 'sign', { platform: 'android', product_id: 'ai.aramo.sign.business.annual', intent_id, purchase_token: 'tok-1' })).toMatchObject({ outcome: 'APPLIED', tenant_id: T1 });
      expect(h.google.acknowledge).toHaveBeenCalledTimes(1);
      expect(h.google.acknowledge).toHaveBeenCalledWith('ai.aramo.sign.business.annual', 'tok-1');
      h.google.purchases.set('tok-1', play(intent_id, { acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' }));
      await h.svc.verify(business, 'sign', { platform: 'android', product_id: 'ai.aramo.sign.business.annual', intent_id, purchase_token: 'tok-1' });
      expect(h.google.acknowledge).toHaveBeenCalledTimes(1);
    });

    it('wrong account id: a token whose obfuscated id is not this intent → 422; another tenant’s → 409; an unknown package token → 422', async () => {
      const h = setup();
      const { intent_id } = await h.svc.createIntent(business, 'sign', { platform: 'android', product_id: 'ai.aramo.sign.business.annual' });
      const second = (await h.svc.createIntent(business, 'sign', { platform: 'android', product_id: 'ai.aramo.sign.business.annual' })).intent_id;
      h.google.purchases.set('tok-2', play(second));
      expect(await refusal(h.svc.verify(business, 'sign', { platform: 'android', product_id: 'ai.aramo.sign.business.annual', intent_id, purchase_token: 'tok-2' }))).toBe('422 store_purchase_invalid wrong_account_id');
      const foreign = (await h.svc.createIntent({ ...business, tenant_id: T2 }, 'sign', { platform: 'android', product_id: 'ai.aramo.sign.business.annual' })).intent_id;
      h.google.purchases.set('tok-3', play(foreign));
      expect(await refusal(h.svc.verify(business, 'sign', { platform: 'android', product_id: 'ai.aramo.sign.business.annual', intent_id, purchase_token: 'tok-3' }))).toBe('409 store_purchase_bound_elsewhere');
      expect(await refusal(h.svc.verify(business, 'sign', { platform: 'android', product_id: 'ai.aramo.sign.business.annual', intent_id, purchase_token: 'tok-other-package' }))).toBe('422 store_purchase_invalid unknown_purchase');
      expect(h.google.acknowledge).not.toHaveBeenCalled();
    });
  });

  describe('notifications', () => {
    it('a verified App Store notification goes into the webhook inbox (the inbox re-fetches the state)', async () => {
      const h = setup();
      expect(await h.svc.receiveAppleNotification('signed-payload', 'sign')).toMatchObject({ outcome: 'APPLIED' });
      expect(h.inbox.receive).toHaveBeenCalledWith(expect.objectContaining({ provider: 'APP_STORE', id: 'n-1', subscription_ref: '2000000100' }), 'sign');
    });
    it('the disabled flag refuses the webhooks (the route answers 404)', async () => {
      vi.stubEnv('SIGN_STORE_BILLING_ENABLED', '0');
      const h = setup();
      expect(await refusal(h.svc.receiveAppleNotification('signed-payload', 'sign'))).toBe('503 store_billing_disabled');
      expect(await refusal(h.svc.receiveGooglePush('Bearer x', {}, 'sign'))).toBe('503 store_billing_disabled');
    });
    it('a Play push that carries no subscription is IGNORED (nothing recorded)', async () => {
      const h = setup();
      expect(await h.svc.receiveGooglePush('Bearer x', {}, 'sign')).toMatchObject({ outcome: 'IGNORED' });
      expect(h.inbox.receive).not.toHaveBeenCalled();
    });
  });

  describe('views', () => {
    it('account: managed_by and the manage link of each channel; eligibility', async () => {
      const h = setup();
      expect(await h.svc.accountView(business, 'sign', 'https://sign.aramo.ai/sign/settings/billing')).toEqual({ managed_by: null, store_purchase_eligible: true, store_purchase_block_reason: null, manage_url: null });
      h.db.subs = [{ id: 'a', tenant_id: T1, source: 'SELF_SERVICE', billing_provider: 'APP_STORE', billing_subscription_ref: '1', ended_at: null }];
      expect(await h.svc.accountView(business, 'sign', 'w')).toMatchObject({ managed_by: 'APP_STORE', manage_url: 'https://apps.apple.com/account/subscriptions' });
      h.db.subs = [{ id: 'g', tenant_id: T1, source: 'SELF_SERVICE', billing_provider: 'GOOGLE_PLAY', billing_subscription_ref: 't', ended_at: null, store_product_id: 'ai.aramo.sign.business.annual' }];
      expect(await h.svc.accountView(business, 'sign', 'w')).toMatchObject({ managed_by: 'GOOGLE_PLAY', manage_url: 'https://play.google.com/store/account/subscriptions?package=ai.aramo.sign&sku=ai.aramo.sign.business.annual' });
      h.db.subs = [{ id: 's', tenant_id: T1, source: 'SELF_SERVICE', billing_provider: 'STRIPE', billing_subscription_ref: 'sub', ended_at: null }];
      expect(await h.svc.accountView(business, 'sign', 'https://sign.aramo.ai/sign/settings/billing')).toEqual({ managed_by: 'STRIPE', store_purchase_eligible: false, store_purchase_block_reason: 'billing_managed_elsewhere', manage_url: 'https://sign.aramo.ai/sign/settings/billing' });
      // India Billing §4.8 — a Razorpay plan is managed on the web (Aramo's manage page), like Stripe.
      h.db.subs = [{ id: 'r', tenant_id: T1, source: 'SELF_SERVICE', billing_provider: 'RAZORPAY', billing_subscription_ref: 'sub_rzp', ended_at: null }];
      expect(await h.svc.accountView(business, 'sign', 'https://sign.aramo.ai/sign/settings/billing')).toEqual({ managed_by: 'RAZORPAY', store_purchase_eligible: false, store_purchase_block_reason: 'billing_managed_elsewhere', manage_url: 'https://sign.aramo.ai/sign/settings/billing' });
    });

    it('plans: the store products of each published version and the regional prices of a country (A1-3); none while dark', async () => {
      const h = setup();
      const offers = await h.svc.planOffers('sign', 'IN');
      expect(offers.get('p-BUSINESS')).toEqual({
        store_products: [
          { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly', interval: 'MONTH' },
          { platform: 'android', product_id: 'ai.aramo.sign.business.annual', interval: 'YEAR' },
        ],
        regional_prices: [
          { country: 'IN', currency: 'INR', amount_minor: 89900, interval: 'MONTH' },
          { country: 'IN', currency: 'INR', amount_minor: 899900, interval: 'YEAR' },
        ],
      });
      expect((await h.svc.planOffers('sign', 'DE')).get('p-BUSINESS')?.regional_prices).toEqual([]);
      vi.stubEnv('SIGN_STORE_BILLING_ENABLED', '0');
      expect((await h.svc.planOffers('sign', 'IN')).get('p-BUSINESS')?.store_products).toEqual([]);
    });
  });
});

describe('M-A12 A1-3 — store vs published regional price reconciliation (a report; nothing blocked)', () => {
  const pin = { plan_key: 'p', plan_version_id: V_BUSINESS, provider: 'GOOGLE_PLAY' as const, product_id: 'ai.aramo.sign.business.monthly', interval: 'MONTH' as const };
  it('MATCH, MISMATCH, NO_REGIONAL_PRICE, NOT_IN_STORE; the US list price is not a regional price', () => {
    const out = reconcileStorePrices(
      [{ ...pin, regional_prices: [{ country: 'IN', currency: 'INR', amount_minor: 89900, interval: 'MONTH' }, { country: 'BR', currency: 'BRL', amount_minor: 4990, interval: 'MONTH' }, { country: 'MX', currency: 'MXN', amount_minor: 19900, interval: 'MONTH' }, { country: 'IN', currency: 'INR', amount_minor: 1, interval: 'YEAR' }] }],
      () => [
        { country: 'IN', currency: 'INR', amount_minor: 89900 },
        { country: 'BR', currency: 'BRL', amount_minor: 5490 },
        { country: 'DE', currency: 'EUR', amount_minor: 999 },
        { country: 'US', currency: 'USD', amount_minor: 1500 },
      ],
    );
    expect(out.map((e) => [e.country, e.status])).toEqual([
      ['BR', 'MISMATCH'],
      ['DE', 'NO_REGIONAL_PRICE'],
      ['IN', 'MATCH'],
      ['MX', 'NOT_IN_STORE'],
    ]);
  });
  it('an unreadable store (Apple, or Play unavailable) is reported, not guessed', () => {
    expect(reconcileStorePrices([{ ...pin, provider: 'APP_STORE', regional_prices: [] }], () => null)).toEqual([{ ...pin, provider: 'APP_STORE', country: null, status: 'STORE_PRICE_UNAVAILABLE', published: null, store: null }]);
  });
});
