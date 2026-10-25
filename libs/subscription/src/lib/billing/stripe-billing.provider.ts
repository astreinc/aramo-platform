import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import {
  type BillingAccountDetails,
  type BillingProviderCommandPort,
  type BillingProviderPort,
  BillingProviderUnavailableError,
  BillingWebhookSignatureError,
  type CheckoutSessionRequest,
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
  wireCheckoutAccountParams,
  wirePortalAccountParams,
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
export class StripeBillingProvider implements BillingProviderPort, BillingProviderCommandPort {
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
      // CCP-C5 (PBD §5.2 row C5, §10) — no tax parameter is sent: the provider is never asked to
      // calculate or collect tax before Stripe Tax registration. The former env opt-in is removed,
      // and no flag replaces it (enabling tax is a future release with its own authorization).
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
    return {
      id: evt['id'],
      type: evt['type'],
      created: asDate(evt['created']),
      subscription_ref: stripeEventSubscriptionRef(evt['type'], data),
      // CCP-C1 — present only for checkout.session.* events (the envelope shape is otherwise unchanged).
      ...(checkout_session_ref !== null ? { checkout_session_ref } : {}),
    };
  }
}
