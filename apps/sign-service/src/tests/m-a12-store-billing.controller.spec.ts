import type { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import type { IdentityRepository } from '@aramo/identity';
import { BillingRefusedError, StoreBillingRefusedError, StoreVerificationError, StripeBillingProvider, type StoreBillingService, type SubscriptionLifecycleService } from '@aramo/subscription';
import { describe, expect, it, vi } from 'vitest';

import { EsignBillingController, billingHttpError } from '../app/billing/esign-billing.controller.js';
import type { EsignOwnerActivationService } from '../app/billing/esign-owner-activation.service.js';
import type { SenderContextService } from '../app/sender/sender-context.service.js';

// Aramo Sign Mobile M-A12 W1-G — the sign-service billing routes for in-app store billing: the plans
// view (kind-filtered catalog + store products + the regional price of the billing country), the
// account view fields, the store intent / verify / restore routes (strict bodies, typed refusals) and
// the App Store / Google Play webhooks (dark → 404, unverifiable → 401, verified → the inbox). The store
// rules themselves are covered in libs/subscription (m-a12-store-billing.spec.ts).

const auth = (scopes: string[] = ['sign:billing:manage', 'sign:envelope:read']): AuthContextType => ({ sub: 'u-owner', tenant_id: 't-1', scopes, consumer_type: 'sign' }) as unknown as AuthContextType;
const INTENT = '019a1200-0000-7000-8000-000000000001';

function setup(opts: { store?: Partial<Record<string, unknown>> | null; kind?: 'BUSINESS' | 'PERSONAL' } = {}) {
  const kind = opts.kind ?? 'BUSINESS';
  const lifecycle = {
    account: vi.fn(async () => ({ subscription: null, allowance: { subscribed: false }, storage: null, billing_available: true, tax: { enabled: false, reason: 'STRIPE_TAX_NOT_REGISTERED' } })),
    sendingOwner: vi.fn(async () => null),
    tenantActivationState: vi.fn(async () => null),
    catalog: vi.fn(async () => [
      { key: 'aramo-sign-business-v2', tenant_kind: 'BUSINESS', purchasable: true, sales_model: 'SELF_SERVICE', price: null },
      { key: 'aramo-sign-professional-v2', tenant_kind: 'BUSINESS', purchasable: true, sales_model: 'SELF_SERVICE', price: null },
    ]),
  } as unknown as SubscriptionLifecycleService;
  const owners = { activate: vi.fn(async () => 'GRANTED') } as unknown as EsignOwnerActivationService;
  const tenant = { id: 't-1', kind, status: 'ACTIVE' };
  const ctx = {
    tenantKind: vi.fn(async () => kind),
    tenantOf: vi.fn(async () => tenant),
    personalAuthoringOpen: vi.fn(() => kind === 'PERSONAL'),
  } as unknown as SenderContextService;
  const identity = {} as unknown as IdentityRepository;
  const personal = { ensureFreeSubscription: vi.fn(async () => undefined) };
  const signups = { declaredResidenceOf: vi.fn(async () => 'IN') };
  const store =
    opts.store === null
      ? undefined
      : ({
          enabled: vi.fn(() => true),
          accountView: vi.fn(async () => ({ managed_by: 'APP_STORE', store_purchase_eligible: true, store_purchase_block_reason: null, manage_url: 'https://apps.apple.com/account/subscriptions' })),
          planOffers: vi.fn(
            async () =>
              new Map([
                [
                  'aramo-sign-business-v2',
                  {
                    store_products: [{ platform: 'ios', product_id: 'ai.aramo.sign.business.monthly', interval: 'MONTH' }],
                    regional_prices: [
                      { country: 'IN', currency: 'INR', amount_minor: 899900, interval: 'YEAR' },
                      { country: 'IN', currency: 'INR', amount_minor: 89900, interval: 'MONTH' },
                    ],
                  },
                ],
              ]),
          ),
          createIntent: vi.fn(async () => ({ intent_id: INTENT, app_account_token: INTENT })),
          verify: vi.fn(async () => ({ outcome: 'APPLIED', tenant_id: 't-1', activated_owner_user_id: 'u-owner' })),
          restore: vi.fn(async () => [{ outcome: 'APPLIED', tenant_id: 't-1' }]),
          receiveAppleNotification: vi.fn(async () => ({ outcome: 'APPLIED', tenant_id: 't-1' })),
          receiveGooglePush: vi.fn(async () => ({ outcome: 'DUPLICATE', tenant_id: null })),
          ...opts.store,
        } as unknown as StoreBillingService);
  const controller = new EsignBillingController(lifecycle, new StripeBillingProvider(), owners, ctx, identity, personal as never, undefined, undefined, signups as never, undefined, store);
  return { controller, lifecycle, owners, store: store as unknown as Record<string, ReturnType<typeof vi.fn>>, personal, signups };
}

const reasonOf = (e: AramoError): string | undefined => (e.context.details as { reason?: string } | undefined)?.reason;
const failure = (p: Promise<unknown>) => p.then(() => 'OK', (e: AramoError) => `${e.statusCode} ${e.code}${reasonOf(e) !== undefined ? ` ${reasonOf(e) as string}` : ''}`);

describe('M-A12 — GET plans and GET account', () => {
  it('plans: the kind-filtered catalog, each plan with its store products and the regional price of the queried country (monthly first)', async () => {
    const { controller, store, lifecycle } = setup();
    const out = (await controller.plans(auth(), 'r', 'in')) as { plans: Record<string, unknown>[] };
    expect(lifecycle.catalog).toHaveBeenCalledWith('sign', 't-1', 'BUSINESS', 'STRIPE');
    expect(store['planOffers']).toHaveBeenCalledWith('sign', 'IN');
    expect(out.plans[0]).toMatchObject({
      key: 'aramo-sign-business-v2',
      store_products: [{ platform: 'ios', product_id: 'ai.aramo.sign.business.monthly', interval: 'MONTH' }],
      regional_price: { country: 'IN', currency: 'INR', amount_minor: 89900, interval: 'MONTH' },
    });
    expect(out.plans[0]?.['regional_prices']).toHaveLength(2);
    expect(out.plans[1]).toMatchObject({ key: 'aramo-sign-professional-v2', store_products: [], regional_price: null, regional_prices: [] });
  });

  it('plans: a PERSONAL tenant without a country falls back to its declared residence; a bad country is ignored', async () => {
    const p = setup({ kind: 'PERSONAL' });
    await p.controller.plans(auth(), 'r');
    expect(p.store['planOffers']).toHaveBeenCalledWith('sign', 'IN');
    const b = setup();
    await b.controller.plans(auth(), 'r', 'India');
    expect(b.store['planOffers']).toHaveBeenCalledWith('sign', null);
  });

  it('account: managed_by, store_purchase_eligible, store_purchase_block_reason and manage_url; unbound → the disabled defaults', async () => {
    const { controller, store } = setup();
    const out = (await controller.account(auth(), 'r')) as Record<string, unknown>;
    expect(out).toMatchObject({ managed_by: 'APP_STORE', store_purchase_eligible: true, store_purchase_block_reason: null, manage_url: 'https://apps.apple.com/account/subscriptions', tenant_kind: 'BUSINESS' });
    expect(store['accountView']).toHaveBeenCalledWith({ tenant_id: 't-1', user_id: 'u-owner', tenant_kind: 'BUSINESS', can_manage: true, personal_open: false }, 'sign', 'https://sign.aramo.ai/sign/settings/billing');
    const dark = (await setup({ store: null }).controller.account(auth(), 'r')) as Record<string, unknown>;
    expect(dark).toMatchObject({ managed_by: null, store_purchase_eligible: false, store_purchase_block_reason: 'store_billing_disabled', manage_url: null });
  });
});

describe('M-A12 — POST store/intent, store/verify, store/restore', () => {
  it('intent: strict body (400), the service answer, typed refusals', async () => {
    const { controller, store } = setup();
    expect(await controller.storeIntent(auth(), 'r', { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly' })).toEqual({ intent_id: INTENT, app_account_token: INTENT });
    expect(store['createIntent']).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: 't-1', tenant_kind: 'BUSINESS', can_manage: true }), 'sign', { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly' });
    expect(await failure(controller.storeIntent(auth(), 'r', { platform: 'web', product_id: 'x' }))).toBe('400 VALIDATION_ERROR');
    expect(await failure(controller.storeIntent(auth(), 'r', { platform: 'ios', product_id: 'x', price: 1 }))).toBe('400 VALIDATION_ERROR');
    expect(await failure(controller.storeIntent(auth(), 'r', { platform: 'ios', product_id: '' }))).toBe('400 VALIDATION_ERROR');
    for (const [reason, want] of [
      ['store_billing_disabled', '503 ESIGN_BILLING_UNAVAILABLE store_billing_disabled'],
      ['not_billing_manager', '403 INSUFFICIENT_PERMISSIONS not_billing_manager'],
      ['store_purchase_seats_unsupported', '409 ESIGN_BILLING_CONFLICT store_purchase_seats_unsupported'],
      ['billing_managed_elsewhere', '409 ESIGN_BILLING_CONFLICT billing_managed_elsewhere'],
    ] as const) {
      const s = setup({ store: { createIntent: vi.fn(async () => { throw new StoreBillingRefusedError(reason); }) } });
      expect(await failure(s.controller.storeIntent(auth(), 'r', { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly' }))).toBe(want);
    }
  });

  it('verify: per-platform required token, uuid intent; success activates the owner and answers the account view', async () => {
    const { controller, store, owners } = setup();
    expect(await failure(controller.storeVerify(auth(), 'r', { platform: 'ios', product_id: 'p', intent_id: INTENT }))).toBe('400 VALIDATION_ERROR');
    expect(await failure(controller.storeVerify(auth(), 'r', { platform: 'android', product_id: 'p', intent_id: INTENT, signed_transaction: 'x' }))).toBe('400 VALIDATION_ERROR');
    expect(await failure(controller.storeVerify(auth(), 'r', { platform: 'ios', product_id: 'p', intent_id: 'not-a-uuid', signed_transaction: 'x' }))).toBe('400 VALIDATION_ERROR');
    const out = (await controller.storeVerify(auth(), 'r', { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly', intent_id: INTENT, signed_transaction: 'jws' })) as Record<string, unknown>;
    expect(store['verify']).toHaveBeenCalledWith(expect.anything(), 'sign', { platform: 'ios', product_id: 'ai.aramo.sign.business.monthly', intent_id: INTENT, signed_transaction: 'jws' });
    expect(owners.activate).toHaveBeenCalledWith('t-1', 'u-owner', 'r');
    expect(out).toMatchObject({ managed_by: 'APP_STORE', tenant_kind: 'BUSINESS' });
    const bad = setup({ store: { verify: vi.fn(async () => { throw new StoreBillingRefusedError('store_purchase_invalid', 'jws_bad_chain'); }) } });
    expect(await failure(bad.controller.storeVerify(auth(), 'r', { platform: 'ios', product_id: 'p', intent_id: INTENT, signed_transaction: 'jws' }))).toBe('422 VALIDATION_ERROR store_purchase_invalid');
    const elsewhere = setup({ store: { verify: vi.fn(async () => { throw new StoreBillingRefusedError('store_purchase_bound_elsewhere'); }) } });
    expect(await failure(elsewhere.controller.storeVerify(auth(), 'r', { platform: 'android', product_id: 'p', intent_id: INTENT, purchase_token: 'tok' }))).toBe('409 ESIGN_BILLING_CONFLICT store_purchase_bound_elsewhere');
  });

  it('restore: at most 10 entries of the platform’s kind; the Personal Free fallback is checked after apply', async () => {
    const { controller, store, personal } = setup({ kind: 'PERSONAL' });
    expect(await failure(controller.storeRestore(auth(), 'r', { platform: 'android', purchase_tokens: Array.from({ length: 11 }, () => 't') }))).toBe('400 VALIDATION_ERROR');
    expect(await failure(controller.storeRestore(auth(), 'r', { platform: 'ios', purchase_tokens: ['t'] }))).toBe('400 VALIDATION_ERROR');
    await controller.storeRestore(auth(), 'r', { platform: 'android', purchase_tokens: ['tok'] });
    expect(store['restore']).toHaveBeenCalledWith(expect.anything(), 'sign', { platform: 'android', purchase_tokens: ['tok'] });
    expect(personal.ensureFreeSubscription).toHaveBeenCalled();
  });
});

describe('M-A12 — POST webhook/app-store and webhook/google-play', () => {
  it('dark (flag off or unbound) → 404; an unverifiable notification → 401; a verified one → its outcome', async () => {
    expect(await failure(setup({ store: null }).controller.appStoreWebhook({ signedPayload: 'x' }, 'r'))).toBe('404 NOT_FOUND');
    expect(await failure(setup({ store: { enabled: vi.fn(() => false) } }).controller.googlePlayWebhook({}, 'Bearer x', 'r'))).toBe('404 NOT_FOUND');
    const forged = setup({ store: { receiveAppleNotification: vi.fn(async () => { throw new StoreVerificationError('jws_untrusted_root'); }) } });
    expect(await failure(forged.controller.appStoreWebhook({ signedPayload: 'x' }, 'r'))).toBe('401 AUTH_REQUIRED jws_untrusted_root');
    const ok = setup();
    expect(await ok.controller.appStoreWebhook({ signedPayload: 'x' }, 'r')).toEqual({ received: true, outcome: 'APPLIED' });
    expect(ok.store['receiveAppleNotification']).toHaveBeenCalledWith('x', 'sign');
    expect(await ok.controller.googlePlayWebhook({ message: {} }, 'Bearer t', 'r')).toEqual({ received: true, outcome: 'DUPLICATE' });
    expect(ok.store['receiveGooglePush']).toHaveBeenCalledWith('Bearer t', { message: {} }, 'sign');
  });
});

describe('M-A12 — a Stripe checkout while a store plan is open', () => {
  it('maps BILLING_MANAGED_ELSEWHERE to 409 billing_managed_elsewhere', () => {
    const e = billingHttpError(new BillingRefusedError('BILLING_MANAGED_ELSEWHERE'), 'r');
    expect([e.statusCode, e.code, reasonOf(e)]).toEqual([409, 'ESIGN_BILLING_CONFLICT', 'billing_managed_elsewhere']);
  });
});
