import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import {
  type BillingAccountDetails,
  type BillingProviderAdjustmentPort,
  type BillingProviderCommandPort,
  type BillingProviderPort,
  BillingProviderUnavailableError,
  BillingWebhookSignatureError,
  type CheckoutSessionRequest,
  type ProviderAdjustmentEffect,
  type ProviderAdjustmentRequest,
  type ProviderCheckoutSessionState,
  type ProviderSubscriptionState,
  type VerifiedBillingEvent,
} from './billing-provider.port.js';
import {
  isWireSubscriptionEvent,
  wireAccountCountry,
  wireAccountParams,
  wireAccountPath,
  wireAccountRef,
  wireBalanceAdjustmentParams,
  wireBalanceAdjustmentState,
  wireCheckoutAccountParams,
  wireCouponParams,
  wireInvoicePayment,
  wireListData,
  wirePortalAccountParams,
  wireRefundParams,
  wireRefundState,
  wireSubscriptionDiscount,
  wireSubscriptionDiscountParams,
  wireSubscriptionQuery,
} from './stripe-wire.js';

// Aramo Sign launch — Stripe over its REST API (no SDK dependency).
//
// Config (platform secrets in the box .env, never in code or data):
//   STRIPE_SECRET_KEY      API key (sk_test_… in test mode, sk_live_… only when live
//                          charging is separately authorized)
//   STRIPE_WEBHOOK_SECRET  endpoint signing secret (whsec_…)
//   STRIPE_API_BASE        optional override (tests point it at a local stand-in)
// Webhooks: Stripe-Signature `t=<unix>,v1=<hex>` = HMAC-SHA256(secret, `${t}.${raw}`),
// verified in constant time within a ±300 s window before anything is parsed.
// The API version is pinned so response shapes are stable.
//
// CCP-C1 — also the command port (cancel a subscription, expire a checkout session, read a
// session). A provider refusal (4xx other than 429) is reported non-retryable; network
// failures, 429 and 5xx stay retryable (BillingProviderUnavailableError.retryable).

export const STRIPE_API_VERSION = '2024-06-20';
export const STRIPE_WEBHOOK_TOLERANCE_SEC = 300;

function form(params: Record<string, string | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
    .join('&');
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asDate(v: unknown): Date {
  return new Date(typeof v === 'number' ? v * 1000 : 0);
}

export function stripeSubscriptionState(obj: Record<string, unknown>): ProviderSubscriptionState {
  const items = (obj['items'] as { data?: Array<{ price?: { id?: string }; current_period_start?: number; current_period_end?: number }> } | undefined)?.data ?? [];
  const metadata = (obj['metadata'] as Record<string, unknown> | undefined) ?? {};
  // Period fields live on the subscription in the pinned API version; newer
  // versions moved them onto the items — accept either.
  const start = obj['current_period_start'] ?? items[0]?.current_period_start;
  const end = obj['current_period_end'] ?? items[0]?.current_period_end;
  return {
    provider: 'STRIPE',
    subscription_ref: String(obj['id']),
    account_ref: wireAccountRef(obj),
    provider_status: String(obj['status']),
    current_period_start: asDate(start),
    current_period_end: asDate(end),
    cancel_at_period_end: obj['cancel_at_period_end'] === true,
    price_ref: asString(items[0]?.price?.id),
    tenant_id: asString(metadata['tenant_id']),
    intent_id: asString(metadata['intent_id']),
    account_country: wireAccountCountry(obj),
  };
}

// The Stripe subscription an event concerns: checkout completion (subscription
// mode), any subscription lifecycle event, and invoice events (pinned version:
// invoice.subscription; newer: parent.subscription_details.subscription).
export function stripeEventSubscriptionRef(type: string, o: Record<string, unknown>): string | null {
  const ref = (v: unknown): string | null =>
    typeof v === 'string' && v !== '' ? v : typeof (v as { id?: unknown } | null)?.id === 'string' ? (v as { id: string }).id : null;
  if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
    return o['mode'] === 'subscription' ? ref(o['subscription']) : null;
  }
  if (isWireSubscriptionEvent(type)) return ref(o['id']);
  if (type.startsWith('invoice.')) {
    return ref(o['subscription']) ?? ref((o['parent'] as { subscription_details?: { subscription?: unknown } } | undefined)?.subscription_details?.subscription);
  }
  return null;
}

/** CCP-C1 — the checkout session a checkout.session.* event concerns. */
export function stripeEventCheckoutSessionRef(type: string, o: Record<string, unknown>): string | null {
  if (!type.startsWith('checkout.session.')) return null;
  return typeof o['id'] === 'string' && o['id'] !== '' ? o['id'] : null;
}

/** CCP-C1 — a Stripe checkout session object → the provider session state. */
export function stripeCheckoutSessionState(obj: Record<string, unknown>): ProviderCheckoutSessionState {
  const metadata = (obj['metadata'] as Record<string, unknown> | undefined) ?? {};
  return {
    provider: 'STRIPE',
    session_ref: String(obj['id']),
    status: String(obj['status']),
    tenant_id: asString(metadata['tenant_id']),
    intent_id: asString(metadata['intent_id']) ?? asString(obj['client_reference_id']),
  };
}

export function verifyStripeSignature(rawBody: Buffer, header: string | undefined, secret: string | undefined, nowSec: number): void {
  if (secret === undefined || secret.length === 0) throw new BillingWebhookSignatureError('NO_SECRET');
  if (header === undefined || header.length === 0) throw new BillingWebhookSignatureError('MISSING');
  let t: string | null = null;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') sigs.push(v);
  }
  if (t === null || !/^\d{1,12}$/.test(t) || sigs.length === 0) throw new BillingWebhookSignatureError('MALFORMED');
  if (Math.abs(nowSec - Number(t)) > STRIPE_WEBHOOK_TOLERANCE_SEC) throw new BillingWebhookSignatureError('STALE');
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex'), 'utf8');
  const ok = sigs.some((s) => {
    const provided = Buffer.from(s, 'utf8');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
  if (!ok) throw new BillingWebhookSignatureError('BAD_SIGNATURE');
}

@Injectable()
export class StripeBillingProvider implements BillingProviderPort, BillingProviderCommandPort, BillingProviderAdjustmentPort {
  readonly provider = 'STRIPE' as const;

  private secretKey(): string | undefined {
    const k = process.env['STRIPE_SECRET_KEY'];
    return k === undefined || k.trim() === '' ? undefined : k.trim();
  }

  private base(): string {
    return (process.env['STRIPE_API_BASE'] ?? 'https://api.stripe.com').replace(/\/+$/, '');
  }

  mode(): 'test' | 'live' {
    const k = this.secretKey() ?? '';
    return k.startsWith('sk_live_') || k.startsWith('rk_live_') ? 'live' : 'test';
  }

  isConfigured(): boolean {
    return this.secretKey() !== undefined && (process.env['STRIPE_WEBHOOK_SECRET'] ?? '').trim() !== '';
  }

  private async call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: string, idempotencyKey?: string): Promise<Record<string, unknown>> {
    const key = this.secretKey();
    if (key === undefined) throw new BillingProviderUnavailableError('STRIPE_SECRET_KEY is not configured');
    let res: Response;
    try {
      res = await fetch(`${this.base()}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          'stripe-version': STRIPE_API_VERSION,
          ...(body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(idempotencyKey !== undefined ? { 'idempotency-key': idempotencyKey } : {}),
        },
        body,
      });
    } catch (err) {
      throw new BillingProviderUnavailableError(`network: ${(err as Error).message}`, true);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const message = ((json['error'] as { message?: string } | undefined)?.message ?? `HTTP ${res.status}`).slice(0, 300);
      // CCP-C1 — a 4xx (other than 429) is the provider refusing this request: not retryable.
      const retryable = res.status === 429 || res.status >= 500;
      throw new BillingProviderUnavailableError(`stripe ${method} ${path}: ${message}`, retryable);
    }
    return json;
  }

  async upsertBillingAccount(account_ref: string | null, details: BillingAccountDetails): Promise<string> {
    // A create is idempotently keyed per tenant + content, so a retried checkout
    // never makes a second account for the same details.
    const body = form(wireAccountParams(details));
    const key =
      account_ref === null ? `aramo-billing-account-${details.tenant_id}-${createHash('sha256').update(body).digest('hex').slice(0, 16)}` : undefined;
    const a = await this.call('POST', wireAccountPath(account_ref), body, key);
    const id = asString(a['id']);
    if (id === null) throw new BillingProviderUnavailableError('billing account without id');
    return id;
  }

  async createCheckoutSession(req: CheckoutSessionRequest): Promise<{ session_ref: string; url: string }> {
    const body = form({
      mode: 'subscription',
      'line_items[0][price]': req.price_ref,
      'line_items[0][quantity]': '1',
      success_url: req.success_url,
      cancel_url: req.cancel_url,
      client_reference_id: req.intent_id,
      ...wireCheckoutAccountParams(req.account_ref, req.user_email),
      // A1 §2.6 — on Aramo's billing account the registered address is used (not
      // re-collected or editable in Checkout).
      billing_address_collection: req.account_ref !== null ? 'auto' : undefined,
      'metadata[tenant_id]': req.tenant_id,
      'metadata[user_id]': req.user_id,
      'metadata[intent_id]': req.intent_id,
      'subscription_data[metadata][tenant_id]': req.tenant_id,
      'subscription_data[metadata][intent_id]': req.intent_id,
      'automatic_tax[enabled]': process.env['STRIPE_AUTOMATIC_TAX'] === '1' ? 'true' : undefined,
    });
    const s = await this.call('POST', '/v1/checkout/sessions', body, `aramo-checkout-${req.intent_id}`);
    const url = asString(s['url']);
    const id = asString(s['id']);
    if (url === null || id === null) throw new BillingProviderUnavailableError('checkout session without id/url');
    return { session_ref: id, url };
  }

  async createPortalSession(account_ref: string, return_url: string, configuration?: string): Promise<{ url: string }> {
    const s = await this.call('POST', '/v1/billing_portal/sessions', form({ ...wirePortalAccountParams(account_ref), return_url, configuration }));
    const url = asString(s['url']);
    if (url === null) throw new BillingProviderUnavailableError('portal session without url');
    return { url };
  }

  async retrieveSubscription(subscription_ref: string): Promise<ProviderSubscriptionState> {
    // A1 §2.6 — the billing account is expanded so its country is re-verified.
    const s = await this.call('GET', `/v1/subscriptions/${encodeURIComponent(subscription_ref)}?${wireSubscriptionQuery()}`);
    return stripeSubscriptionState(s);
  }

  async cancelSubscription(subscription_ref: string, opts: { at_period_end: boolean }, idempotency_key: string): Promise<void> {
    const path = `/v1/subscriptions/${encodeURIComponent(subscription_ref)}`;
    // At period end: the subscription keeps running until the period ends (an update). Now: the
    // provider's cancel (no proration or invoice parameters are sent: their defaults apply).
    if (opts.at_period_end) await this.call('POST', path, form({ cancel_at_period_end: 'true' }), idempotency_key);
    else await this.call('DELETE', path, undefined, idempotency_key);
  }

  async expireCheckoutSession(session_ref: string, idempotency_key: string): Promise<void> {
    await this.call('POST', `/v1/checkout/sessions/${encodeURIComponent(session_ref)}/expire`, '', idempotency_key);
  }

  async retrieveCheckoutSession(session_ref: string): Promise<ProviderCheckoutSessionState> {
    return stripeCheckoutSessionState(await this.call('GET', `/v1/checkout/sessions/${encodeURIComponent(session_ref)}`));
  }

  // ---- CCP-C4 — billing adjustments (credits, discounts, refunds) -------------------------------
  // Every write carries the command's derived idempotency key and `aramo_command_id` / `tenant_id`
  // metadata. Reads never change provider state. Paths and field names: stripe-wire.ts.

  async executeAdjustment(req: ProviderAdjustmentRequest, idempotency_key: string): Promise<{ object_ref: string }> {
    switch (req.operation) {
      case 'CREDIT_GRANT':
      case 'CREDIT_REVERSE': {
        // A credit lowers the balance the next invoice draws on (negative); its reversal raises it.
        const signed = (req.operation === 'CREDIT_GRANT' ? -1 : 1) * (req.amount_minor as number);
        const t = await this.call('POST', `${wireAccountPath(req.target_ref)}/balance_transactions`, form(wireBalanceAdjustmentParams(signed, req.currency as string, req)), idempotency_key);
        return { object_ref: requireId(t, 'balance adjustment') };
      }
      case 'DISCOUNT_APPLY': {
        // A coupon with the deterministic id (a retry finds it), then attached to the subscription.
        try {
          await this.call('POST', '/v1/coupons', form(wireCouponParams(req.coupon_ref as string, req.discount_bps as number, req)), `${idempotency_key}-coupon`);
        } catch (e) {
          if (!(e instanceof BillingProviderUnavailableError) || e.retryable || !/already exists/i.test(e.detail)) throw e;
        }
        const sub = await this.call('POST', `/v1/subscriptions/${encodeURIComponent(req.target_ref)}`, form(wireSubscriptionDiscountParams(req.coupon_ref as string)), idempotency_key);
        return { object_ref: wireSubscriptionDiscount(sub).discount_ref ?? (req.coupon_ref as string) };
      }
      case 'DISCOUNT_REMOVE': {
        await this.call('DELETE', `/v1/subscriptions/${encodeURIComponent(req.target_ref)}/discount`, undefined, idempotency_key);
        return { object_ref: req.target_ref };
      }
      case 'REFUND_CREATE': {
        const inv = wireInvoicePayment(await this.call('GET', `/v1/invoices/${encodeURIComponent(req.target_ref)}`));
        if (inv.account_ref !== req.account_ref) throw new BillingProviderUnavailableError('the invoice was not paid from the tenant billing account', false);
        if (inv.payment_ref === null) throw new BillingProviderUnavailableError('the invoice has no payment to refund', false);
        const r = await this.call('POST', '/v1/refunds', form(wireRefundParams(inv.payment_ref, req.amount_minor as number, req)), idempotency_key);
        return { object_ref: requireId(r, 'refund') };
      }
    }
  }

  async readAdjustmentEffect(req: ProviderAdjustmentRequest, object_ref: string | null): Promise<ProviderAdjustmentEffect> {
    const none = (o: Partial<ProviderAdjustmentEffect> = {}): ProviderAdjustmentEffect => ({ provider: 'STRIPE', operation: req.operation, object_ref: null, present: false, provider_status: null, tenant_id: null, live: this.mode() === 'live', ...o });
    switch (req.operation) {
      case 'CREDIT_GRANT':
      case 'CREDIT_REVERSE': {
        const signed = (req.operation === 'CREDIT_GRANT' ? -1 : 1) * (req.amount_minor as number);
        const objs =
          object_ref !== null
            ? [await this.call('GET', `${wireAccountPath(req.target_ref)}/balance_transactions/${encodeURIComponent(object_ref)}`)]
            : wireListData(await this.call('GET', `${wireAccountPath(req.target_ref)}/balance_transactions?limit=100`));
        for (const o of objs) {
          const t = wireBalanceAdjustmentState(o);
          if (t.command_id !== req.command_id) continue;
          const ok = t.amount_minor === signed && t.currency === (req.currency as string).toLowerCase();
          return none({ object_ref: t.object_ref, present: ok, provider_status: ok ? 'applied' : 'mismatch', tenant_id: t.tenant_id, live: t.live });
        }
        return none();
      }
      case 'DISCOUNT_APPLY':
      case 'DISCOUNT_REMOVE': {
        const sub = await this.call('GET', `/v1/subscriptions/${encodeURIComponent(req.target_ref)}`);
        const d = wireSubscriptionDiscount(sub);
        const has = d.coupon_ref === req.coupon_ref;
        const tenant_id = asString(((sub['metadata'] as Record<string, unknown> | undefined) ?? {})['tenant_id']);
        return none({ object_ref: d.discount_ref ?? (req.operation === 'DISCOUNT_REMOVE' ? req.target_ref : null), present: req.operation === 'DISCOUNT_APPLY' ? has : !has, provider_status: d.coupon_ref === null ? 'none' : 'active', tenant_id, live: sub['livemode'] === true });
      }
      case 'REFUND_CREATE': {
        // CCP-C4-R — always the authoritative picture of the payment: the invoice (paying account,
        // payment, currency, amount paid) and every refund of that payment; the command's refund is
        // found by its object ref, else by the command id in its metadata.
        const inv = wireInvoicePayment(await this.call('GET', `/v1/invoices/${encodeURIComponent(req.target_ref)}`));
        const refunds = inv.payment_ref === null ? [] : wireListData(await this.call('GET', `/v1/refunds?payment_intent=${encodeURIComponent(inv.payment_ref)}&limit=100`)).map(wireRefundState);
        const committed = refunds.filter((r) => r.status === 'succeeded' || r.status === 'pending' || r.status === 'requires_action').reduce((n, r) => n + r.amount_minor, 0);
        const facts = { refundable_remainder_minor: inv.payment_ref === null ? 0 : Math.max(inv.amount_paid_minor - committed, 0), payment_currency: inv.currency };
        const mine = refunds.find((r) => (object_ref !== null ? r.object_ref === object_ref : r.command_id === req.command_id));
        if (mine === undefined) return none({ ...facts, observed_amount_minor: null });
        return none({ ...facts, object_ref: mine.object_ref, present: mine.status === 'succeeded' && mine.amount_minor === req.amount_minor, provider_status: mine.status, tenant_id: mine.tenant_id, live: mine.live, observed_amount_minor: mine.amount_minor });
      }
    }
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined, nowSec: number): VerifiedBillingEvent {
    verifyStripeSignature(rawBody, signatureHeader, process.env['STRIPE_WEBHOOK_SECRET']?.trim(), nowSec);
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new BillingWebhookSignatureError('MALFORMED');
    }
    const data = (evt['data'] as { object?: Record<string, unknown> } | undefined)?.object;
    if (typeof evt['id'] !== 'string' || typeof evt['type'] !== 'string' || data === undefined) {
      throw new BillingWebhookSignatureError('MALFORMED');
    }
    const checkout_session_ref = stripeEventCheckoutSessionRef(evt['type'], data);
    const subscription_ref = stripeEventSubscriptionRef(evt['type'], data);
    // CCP-C4 — any other event names its own object (a balance adjustment, discount or refund), so a
    // pending billing adjustment whose object it is can be re-read. Absent otherwise (the C1
    // envelope of subscription and checkout events is unchanged).
    const object_ref = subscription_ref === null && checkout_session_ref === null ? asString(data['id']) : null;
    return {
      id: evt['id'],
      type: evt['type'],
      created: asDate(evt['created']),
      subscription_ref,
      // CCP-C1 — present only for checkout.session.* events (the envelope shape is otherwise unchanged).
      ...(checkout_session_ref !== null ? { checkout_session_ref } : {}),
      ...(object_ref !== null ? { object_ref } : {}),
    };
  }
}

function requireId(o: Record<string, unknown>, what: string): string {
  const id = asString(o['id']);
  if (id === null) throw new BillingProviderUnavailableError(`${what} without id`);
  return id;
}

