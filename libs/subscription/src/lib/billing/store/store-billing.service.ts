import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { planVersionTerms, regionalPricesOf } from '../../plan-version.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { assertProductKey, openBaseSubscription, type ProductKey } from '../../product-registry.js';
import { type ProviderSubscriptionState, type StoreBillingProviderKey, type VerifiedBillingEvent, isStoreBillingProvider, isWebBillingProvider } from '../billing-provider.port.js';
import { BillingWebhookInboxService } from '../billing-webhook-inbox.service.js';
import { isGovernedSubscription, takeBillingLock } from '../governed-subscription.js';
import { ORGANIZATION_BILLING_PROFILE_PORT, type OrganizationBillingProfilePort } from '../organization-billing-profile.port.js';
import { resolveStoreProductToVersion, storeProductsOfVersion } from '../provider-price.js';
import { type ApplyResult, SubscriptionLifecycleService, type WebhookResult, planMatchesTenantKind } from '../subscription-lifecycle.service.js';

import type { AppleAppStoreAdapter } from './apple-app-store.adapter.js';
import type { GooglePlayAdapter, PlayStoreRegionalPrice } from './google-play.adapter.js';
import { APPLE_MANAGE_SUBSCRIPTIONS_URL, googlePlayManageUrl, storeBillingEnabled } from './store-billing.config.js';
import { APPLE_APP_STORE_PORT, GOOGLE_PLAY_PORT, StoreVerificationError } from './store-billing.port.js';
import { playSubscriptionState } from './store-state.js';
import { type StorePriceReconciliationEntry, reconcileStorePrices } from './store-price-reconciliation.js';

// Aramo Sign Mobile M-A12 W1-G (LOCKED) with Amendment A1 — buying a Sign plan with only the native app.
//
//   intent    a purchase intent (subscription."CheckoutIntent", provider APP_STORE | GOOGLE_PLAY) for one
//             pinned store product of a plan of the caller's tenant kind. Its id is the appAccountToken
//             (iOS) / obfuscatedExternalAccountId (Android) the app passes to the store, so every store
//             transaction carries the tenant binding.
//   verify    server-side and authoritative: Apple — the signed transaction's x5c chain to Apple Root CA
//             G3, bundle, environment, appAccountToken; Google — subscriptionsv2.get for our package and
//             the obfuscated account id. The state applied is RE-FETCHED from the store and applied by the
//             existing lifecycle (one status machine, the activation guards, the subscribing-owner role).
//             Idempotent on the store reference. A purchase bound to another tenant → bound elsewhere.
//   restore   the same verification for the transactions / tokens the device holds.
//   notify    App Store Server Notifications v2 and Google RTDN → the existing webhook inbox; the inbox
//             re-fetches the store state (never the payload's).
// A1-2 — the purchaser must manage billing and be the tenant's ONLY active member; PERSONAL buys
// Personal plans only, BUSINESS Business self-service plans only (A5). W1-G item 5 — an open Stripe or
// governed subscription refuses a store purchase (billing_managed_elsewhere), and the lifecycle refuses
// a Stripe checkout while a store subscription is open. Dark unless SIGN_STORE_BILLING_ENABLED=1.
// Receipts, JWS, purchase tokens and keys are never logged.

export const TENANT_MEMBERSHIP_PORT = 'TENANT_MEMBERSHIP_PORT';

/** A1-2 — the tenant's active members (identity lives in the service layer). */
export interface TenantMembershipPort {
  activeMemberCount(tenant_id: string): Promise<number>;
}

export type StorePlatform = 'ios' | 'android';

export type StorePurchaseBlockReason = 'store_billing_disabled' | 'not_billing_manager' | 'store_purchase_seats_unsupported' | 'billing_managed_elsewhere';

export type StoreRefusalReason =
  | StorePurchaseBlockReason
  | 'store_purchase_bound_elsewhere'
  | 'store_purchase_invalid'
  | 'store_product_not_available'
  | 'domain_verification_required';

const STATUS: Record<StoreRefusalReason, number> = {
  store_billing_disabled: 503,
  not_billing_manager: 403,
  store_purchase_seats_unsupported: 409,
  billing_managed_elsewhere: 409,
  store_purchase_bound_elsewhere: 409,
  store_purchase_invalid: 422,
  store_product_not_available: 409,
  domain_verification_required: 409,
};

export class StoreBillingRefusedError extends Error {
  readonly status: number;
  constructor(
    public readonly reason: StoreRefusalReason,
    public readonly detail?: string,
  ) {
    super(`store purchase refused: ${reason}${detail !== undefined ? ` (${detail})` : ''}`);
    this.name = 'StoreBillingRefusedError';
    this.status = STATUS[reason];
  }
}

export interface StoreCaller {
  tenant_id: string;
  user_id: string;
  tenant_kind: string;
  /** The caller holds billing management (sign:billing:manage). */
  can_manage: boolean;
  /** PERSONAL: Personal authoring is open for the tenant (a bound Personal tenant). */
  personal_open: boolean;
}

export interface StoreAccountView {
  // India Billing §4.8 — RAZORPAY is a web gateway, managed on the web like STRIPE.
  managed_by: 'STRIPE' | 'RAZORPAY' | 'APP_STORE' | 'GOOGLE_PLAY' | null;
  store_purchase_eligible: boolean;
  store_purchase_block_reason: StorePurchaseBlockReason | null;
  manage_url: string | null;
}

export interface StorePlanOffer {
  store_products: { platform: StorePlatform; product_id: string; interval: 'MONTH' | 'YEAR' }[];
  regional_prices: { country: string; currency: string; amount_minor: number; interval: 'MONTH' | 'YEAR' }[];
}

export function storeProviderOf(platform: StorePlatform): StoreBillingProviderKey {
  return platform === 'ios' ? 'APP_STORE' : 'GOOGLE_PLAY';
}

/** A1-2 / W1-G item 5 — the decision, pure (ordered: disabled, manager, managed elsewhere, seats). */
export function storePurchaseBlock(input: {
  enabled: boolean;
  can_manage: boolean;
  tenant_kind: string;
  personal_open: boolean;
  open: { source: string; billing_provider: string | null } | null;
  active_members: number | null;
}): StorePurchaseBlockReason | null {
  if (!input.enabled) return 'store_billing_disabled';
  if (!input.can_manage || (input.tenant_kind === 'PERSONAL' && !input.personal_open)) return 'not_billing_manager';
  if (input.open !== null) {
    // India Billing §4.8 — any web gateway (Stripe, Razorpay) manages the plan on the web.
    if (input.open.source === 'SELF_SERVICE' && isWebBillingProvider(input.open.billing_provider)) return 'billing_managed_elsewhere';
    // An open governed (MANUAL) subscription is managed by Aramo (the rows passed in are open).
    if (input.open.source === 'MANUAL') return 'billing_managed_elsewhere';
  }
  if (input.active_members !== 1) return 'store_purchase_seats_unsupported';
  return null;
}

@Injectable()
export class StoreBillingService {
  private readonly log = new Logger(StoreBillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: SubscriptionLifecycleService,
    @Optional() @Inject(APPLE_APP_STORE_PORT) private readonly apple?: AppleAppStoreAdapter,
    @Optional() @Inject(GOOGLE_PLAY_PORT) private readonly google?: GooglePlayAdapter,
    @Optional() @Inject(TENANT_MEMBERSHIP_PORT) private readonly members?: TenantMembershipPort,
    @Optional() private readonly inbox?: BillingWebhookInboxService,
    @Optional() @Inject(ORGANIZATION_BILLING_PROFILE_PORT) private readonly orgProfile?: OrganizationBillingProfilePort,
  ) {}

  enabled(): boolean {
    return storeBillingEnabled();
  }

  platformConfigured(platform: StorePlatform): boolean {
    return (platform === 'ios' ? this.apple : this.google)?.isConfigured() === true;
  }

  private async activeMembers(tenant_id: string): Promise<number | null> {
    if (this.members === undefined) return null;
    try {
      return await this.members.activeMemberCount(tenant_id);
    } catch (e) {
      this.log.warn(`active member count failed for ${tenant_id}: ${(e as Error).name}`);
      return null;
    }
  }

  private openRow(tenant_id: string, product_key: ProductKey) {
    return this.prisma.tenantSubscription.findFirst({ where: openBaseSubscription(tenant_id, product_key) });
  }

  /** GET account — where the plan is managed and whether the caller may buy in the app. */
  async accountView(caller: StoreCaller, product_key: ProductKey, web_manage_url: string): Promise<StoreAccountView> {
    const open = await this.openRow(caller.tenant_id, assertProductKey(product_key));
    const managed_by = open !== null && open.source === 'SELF_SERVICE' && (isWebBillingProvider(open.billing_provider) || isStoreBillingProvider(open.billing_provider)) ? (open.billing_provider as StoreAccountView['managed_by']) : null;
    const reason = storePurchaseBlock({
      enabled: this.enabled(),
      can_manage: caller.can_manage,
      tenant_kind: caller.tenant_kind,
      personal_open: caller.personal_open,
      open,
      active_members: await this.activeMembers(caller.tenant_id),
    });
    const manage_url =
      managed_by === 'APP_STORE'
        ? APPLE_MANAGE_SUBSCRIPTIONS_URL
        : managed_by === 'GOOGLE_PLAY'
          ? googlePlayManageUrl(this.google?.packageName ?? 'ai.aramo.sign', open?.store_product_id ?? null)
          : isWebBillingProvider(managed_by)
            ? web_manage_url
            : null;
    return { managed_by, store_purchase_eligible: reason === null, store_purchase_block_reason: reason, manage_url };
  }

  /** GET plans — the store products and regional prices of each plan's PUBLISHED version (key → offer). */
  async planOffers(product_key: ProductKey, country: string | null): Promise<Map<string, StorePlanOffer>> {
    const versions = await this.prisma.planVersion.findMany({ where: { status: 'PUBLISHED', plan: { product_key: assertProductKey(product_key) } }, include: { plan: { select: { key: true } } } });
    const out = new Map<string, StorePlanOffer>();
    const enabled = this.enabled();
    for (const v of versions) {
      const terms = planVersionTerms(v);
      out.set(v.plan.key, {
        // Dark: no store product is offered while store billing is off.
        store_products: enabled ? await storeProductsOfVersion(this.prisma, v.id) : [],
        regional_prices: regionalPricesOf(terms, country).map((r) => ({ ...r })),
      });
    }
    return out;
  }

  private assertEnabled(platform: StorePlatform): void {
    if (!this.enabled() || !this.platformConfigured(platform)) throw new StoreBillingRefusedError('store_billing_disabled');
  }

  /** A1-2 gate for a NEW purchase (intent): every reason. */
  private async assertMayPurchase(caller: StoreCaller, product_key: ProductKey): Promise<void> {
    const reason = storePurchaseBlock({
      enabled: true,
      can_manage: caller.can_manage,
      tenant_kind: caller.tenant_kind,
      personal_open: caller.personal_open,
      open: await this.openRow(caller.tenant_id, product_key),
      active_members: await this.activeMembers(caller.tenant_id),
    });
    if (reason !== null) throw new StoreBillingRefusedError(reason);
  }

  /** POST store/intent — the tenant-bound token for one store purchase. */
  async createIntent(caller: StoreCaller, product_key: ProductKey, input: { platform: StorePlatform; product_id: string }): Promise<{ intent_id: string; app_account_token: string }> {
    assertProductKey(product_key);
    this.assertEnabled(input.platform);
    await this.assertMayPurchase(caller, product_key);
    const provider = storeProviderOf(input.platform);
    const resolved = await resolveStoreProductToVersion(this.prisma, provider, input.product_id, product_key);
    const plan = resolved === null ? null : await this.prisma.plan.findUnique({ where: { id: resolved.plan_id } });
    // A new purchase is only of a product pinned to its plan's CURRENT (PUBLISHED) version, of a
    // sellable self-service plan of the caller's kind (A5: Personal stays Personal).
    if (
      resolved === null ||
      plan === null ||
      resolved.version_status !== 'PUBLISHED' ||
      plan.status !== 'ACTIVE' ||
      plan.sales_model !== 'SELF_SERVICE' ||
      !planMatchesTenantKind(plan.tenant_kind, caller.tenant_kind)
    ) {
      throw new StoreBillingRefusedError('store_product_not_available');
    }
    // P3 §4 — a new Business self-service subscription needs an AUTHORITATIVE domain claim (the
    // lifecycle would otherwise hold the activation after the user paid): refused before the purchase.
    if (caller.tenant_kind !== 'PERSONAL' && !(await this.domainAuthoritative(caller.tenant_id))) throw new StoreBillingRefusedError('domain_verification_required');
    const intent_id = uuidv7();
    await this.prisma.$transaction(async (tx) => {
      await takeBillingLock(tx, caller.tenant_id);
      const open = await tx.tenantSubscription.findFirst({ where: openBaseSubscription(caller.tenant_id, product_key) });
      if (open !== null && ((open.source === 'SELF_SERVICE' && isWebBillingProvider(open.billing_provider)) || isGovernedSubscription(open))) throw new StoreBillingRefusedError('billing_managed_elsewhere');
      await tx.checkoutIntent.create({
        data: { id: intent_id, tenant_id: caller.tenant_id, user_id: caller.user_id, plan_id: plan.id, provider, store_product_id: input.product_id },
      });
    });
    return { intent_id, app_account_token: intent_id };
  }

  private async domainAuthoritative(tenant_id: string): Promise<boolean> {
    if (this.orgProfile === undefined) return false;
    try {
      return (await this.orgProfile.domainAuthoritative(tenant_id)) === true;
    } catch {
      return false;
    }
  }

  /** The tenant an Aramo purchase token (intent id) is bound to, or null when unknown. */
  private async intentTenant(token: string | null, provider: StoreBillingProviderKey): Promise<string | null> {
    if (token === null || !/^[0-9a-f-]{36}$/.test(token)) return null;
    const intent = await this.prisma.checkoutIntent.findUnique({ where: { id: token }, select: { tenant_id: true, provider: true } });
    return intent === null || intent.provider !== provider ? null : intent.tenant_id;
  }

  /** The store reference is not already a subscription of another tenant (bound elsewhere). */
  private async assertRefNotElsewhere(provider: StoreBillingProviderKey, ref: string, tenant_id: string): Promise<void> {
    const row = await this.prisma.tenantSubscription.findFirst({ where: { billing_provider: provider, billing_subscription_ref: ref }, select: { tenant_id: true } });
    if (row !== null && row.tenant_id !== tenant_id) throw new StoreBillingRefusedError('store_purchase_bound_elsewhere');
  }

  /** The binding token resolves to the caller's tenant (another tenant → bound elsewhere; none → invalid). */
  private async assertBound(token: string | null, provider: StoreBillingProviderKey, tenant_id: string, expected_intent?: string): Promise<void> {
    const owner = await this.intentTenant(token, provider);
    if (owner === null) throw new StoreBillingRefusedError('store_purchase_invalid', 'account_token_unknown');
    if (owner !== tenant_id) throw new StoreBillingRefusedError('store_purchase_bound_elsewhere');
    if (expected_intent !== undefined && provider === 'GOOGLE_PLAY' && token !== expected_intent) throw new StoreBillingRefusedError('store_purchase_invalid', 'wrong_account_id');
  }

  /** Re-check at verify / restore: the caller manages billing and no Stripe or governed plan is open. */
  private async assertMayBind(caller: StoreCaller, product_key: ProductKey): Promise<void> {
    if (!caller.can_manage || (caller.tenant_kind === 'PERSONAL' && !caller.personal_open)) throw new StoreBillingRefusedError('not_billing_manager');
    const open = await this.openRow(caller.tenant_id, product_key);
    if (open !== null && ((open.source === 'SELF_SERVICE' && isWebBillingProvider(open.billing_provider)) || isGovernedSubscription(open))) throw new StoreBillingRefusedError('billing_managed_elsewhere');
  }

  private wrap<T>(p: Promise<T>): Promise<T> {
    return p.catch((e: unknown) => {
      if (e instanceof StoreVerificationError) throw new StoreBillingRefusedError('store_purchase_invalid', e.reason);
      throw e;
    });
  }

  /** POST store/verify — one purchase, verified server-side, then applied from the store's state. */
  async verify(
    caller: StoreCaller,
    product_key: ProductKey,
    input: { platform: StorePlatform; product_id: string; intent_id: string; signed_transaction?: string; purchase_token?: string },
    at: Date = new Date(),
  ): Promise<ApplyResult> {
    assertProductKey(product_key);
    this.assertEnabled(input.platform);
    await this.assertMayBind(caller, product_key);
    if (input.platform === 'ios') {
      if (typeof input.signed_transaction !== 'string') throw new StoreBillingRefusedError('store_purchase_invalid', 'signed_transaction_required');
      return this.wrap(this.bindApple(caller, product_key, input.signed_transaction, input.product_id, at));
    }
    if (typeof input.purchase_token !== 'string') throw new StoreBillingRefusedError('store_purchase_invalid', 'purchase_token_required');
    return this.wrap(this.bindGoogle(caller, product_key, input.purchase_token, input.product_id, input.intent_id, at));
  }

  /** POST store/restore — the device's transactions / tokens, each verified and applied. */
  async restore(
    caller: StoreCaller,
    product_key: ProductKey,
    input: { platform: StorePlatform; signed_transactions?: string[]; purchase_tokens?: string[] },
    at: Date = new Date(),
  ): Promise<ApplyResult[]> {
    assertProductKey(product_key);
    this.assertEnabled(input.platform);
    await this.assertMayBind(caller, product_key);
    const items = input.platform === 'ios' ? (input.signed_transactions ?? []) : (input.purchase_tokens ?? []);
    const out: ApplyResult[] = [];
    for (const item of items.slice(0, 10)) {
      out.push(await this.wrap(input.platform === 'ios' ? this.bindApple(caller, product_key, item, null, at) : this.bindGoogle(caller, product_key, item, null, null, at)));
    }
    return out;
  }

  private async bindApple(caller: StoreCaller, product_key: ProductKey, jws: string, product_id: string | null, at: Date): Promise<ApplyResult> {
    const apple = this.apple as AppleAppStoreAdapter;
    const t = await apple.verifyTransaction(jws);
    if (product_id !== null && t.product_id !== product_id) throw new StoreBillingRefusedError('store_purchase_invalid', 'product_mismatch');
    await this.assertBound(t.app_account_token, 'APP_STORE', caller.tenant_id);
    await this.assertRefNotElsewhere('APP_STORE', t.original_transaction_id, caller.tenant_id);
    // The state applied is re-fetched from the App Store Server API (never the device's payload).
    const state = await apple.retrieveSubscription(t.original_transaction_id);
    return this.applyBound(caller, state, product_key, at);
  }

  private async bindGoogle(caller: StoreCaller, product_key: ProductKey, token: string, product_id: string | null, intent_id: string | null, at: Date): Promise<ApplyResult> {
    const google = this.google as GooglePlayAdapter;
    // The state applied is the Android Publisher answer itself (subscriptionsv2.get), never the device's.
    const purchase = await google.getPurchase(token);
    const state = playSubscriptionState(token, purchase);
    if (product_id !== null && state.price_ref !== product_id) throw new StoreBillingRefusedError('store_purchase_invalid', 'product_mismatch');
    await this.assertBound(state.intent_id, 'GOOGLE_PLAY', caller.tenant_id, intent_id ?? undefined);
    await this.assertRefNotElsewhere('GOOGLE_PLAY', token, caller.tenant_id);
    const result = await this.applyBound(caller, state, product_key, at);
    // A purchase Aramo now holds is acknowledged (Play refunds one left unacknowledged for three days).
    if (purchase.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING' && state.price_ref !== null && (await this.heldByTenant('GOOGLE_PLAY', token, caller.tenant_id))) {
      await google.acknowledge(state.price_ref, token);
    }
    return result;
  }

  private async heldByTenant(provider: StoreBillingProviderKey, ref: string, tenant_id: string): Promise<boolean> {
    return (await this.prisma.tenantSubscription.count({ where: { billing_provider: provider, billing_subscription_ref: ref, tenant_id } })) > 0;
  }

  private async applyBound(caller: StoreCaller, state: ProviderSubscriptionState, product_key: ProductKey, at: Date): Promise<ApplyResult> {
    const result = await this.lifecycle.applyProviderState(state, product_key, at);
    if (result.tenant_id !== null && result.tenant_id !== caller.tenant_id) throw new StoreBillingRefusedError('store_purchase_bound_elsewhere');
    return result;
  }

  /** POST webhook/app-store — a verified notification, into the inbox (state re-fetched there). */
  async receiveAppleNotification(signedPayload: unknown, product_key: ProductKey): Promise<WebhookResult> {
    if (!this.enabled() || this.apple?.isConfigured() !== true) throw new StoreBillingRefusedError('store_billing_disabled');
    if (typeof signedPayload !== 'string') throw new StoreVerificationError('malformed');
    return this.record(await this.apple.verifyNotification(signedPayload), product_key);
  }

  /** POST webhook/google-play — a verified Pub/Sub push, into the inbox (state re-fetched there). */
  async receiveGooglePush(authorization: string | undefined, body: unknown, product_key: ProductKey): Promise<WebhookResult> {
    if (!this.enabled() || this.google?.pushConfigured() !== true) throw new StoreBillingRefusedError('store_billing_disabled');
    const evt = await this.google.verifyPush(authorization, body);
    if (evt === null) return { outcome: 'IGNORED', detail: 'notification carries no subscription', tenant_id: null };
    return this.record(evt, product_key);
  }

  private record(evt: VerifiedBillingEvent, product_key: ProductKey): Promise<WebhookResult> {
    return this.inbox !== undefined ? this.inbox.receive(evt, product_key) : this.lifecycle.handleEvent(evt, product_key);
  }

  /**
   * A1-3 — the reconciliation report: each store product of a PUBLISHED version against the version's
   * regional prices. Read only; nothing is blocked at runtime. Apple prices are not read (the App
   * Store Connect pricing API needs a separate API key): those products report STORE_PRICE_UNAVAILABLE.
   */
  async priceReconciliation(product_key: ProductKey): Promise<StorePriceReconciliationEntry[]> {
    const pins = await this.prisma.planVersionPrice.findMany({
      where: { provider: { in: ['APP_STORE', 'GOOGLE_PLAY'] }, plan_version: { status: 'PUBLISHED', plan: { product_key: assertProductKey(product_key) } } },
      include: { plan_version: { include: { plan: { select: { key: true } } } } },
      orderBy: [{ provider: 'asc' }, { provider_price_ref: 'asc' }],
    });
    const observed = new Map<string, PlayStoreRegionalPrice[] | null>();
    for (const p of pins) {
      if (p.provider !== 'GOOGLE_PLAY' || observed.has(p.provider_price_ref)) continue;
      try {
        observed.set(p.provider_price_ref, this.google?.isConfigured() === true ? await this.google.regionalPrices(p.provider_price_ref) : null);
      } catch {
        observed.set(p.provider_price_ref, null);
      }
    }
    return reconcileStorePrices(
      pins.map((p) => ({
        plan_key: p.plan_version.plan.key,
        plan_version_id: p.plan_version_id,
        provider: p.provider as StoreBillingProviderKey,
        product_id: p.provider_price_ref,
        interval: p.interval === 'YEAR' ? 'YEAR' : 'MONTH',
        regional_prices: planVersionTerms(p.plan_version).regional_prices ?? [],
      })),
      (provider, product_id) => (provider === 'GOOGLE_PLAY' ? (observed.get(product_id) ?? null) : null),
    );
  }
}
