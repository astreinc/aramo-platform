import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import {
  type BillingAccountDetails,
  type BillingProviderCommandPort,
  type BillingProviderPort,
  type BillingProviderSeatPort,
  BillingProviderUnavailableError,
  BillingWebhookSignatureError,
  type CheckoutSessionRequest,
  type ProviderCheckoutSessionState,
  type ProviderSubscriptionState,
  type SeatProrationBehavior,
  type VerifiedBillingEvent,
} from './billing-provider.port.js';
import { razorpayWireAccountPath, razorpayWireAccountRef, razorpayWireSubscriptionAccountFields } from './razorpay-wire.js';

// India Billing Regions + Razorpay (Implementation Directive v1.0 LOCKED §4.5) — Razorpay
// Subscriptions over its REST API v1 (no SDK dependency). Mirrors StripeBillingProvider's semantics.
//
// Config (platform secrets in the box .env, never in code, data or logs):
//   RAZORPAY_KEY_ID          API key id (rzp_test_… in test mode; rzp_live_… only when live charging
//                            is separately authorized)
//   RAZORPAY_KEY_SECRET      API key secret (HTTP Basic auth key_id:key_secret)
//   RAZORPAY_WEBHOOK_SECRET  webhook signing secret
//   RAZORPAY_API_BASE        optional override (tests point it at a local stand-in)
// Dark-launch G-2: without all three secrets the adapter is isConfigured()=false.
//
// Checkout = a Razorpay subscription in `created` state; its `short_url` is the hosted
// authorization page (UPI Autopay, cards, netbanking mandate) the payer is redirected to. The
// subscription id doubles as the checkout session ref. `total_count` = 120 billing cycles: Razorpay
// needs a finite cycle count, and 120 monthly cycles is ten years (only MONTH prices are sold on
// Razorpay in v1, directive §7 "YEAR prices on Razorpay" out of scope).
//
// Webhooks: X-Razorpay-Signature = hex HMAC-SHA256(RAZORPAY_WEBHOOK_SECRET, raw body), verified in
// constant time before anything is parsed. Razorpay signs no timestamp, so there is no staleness
// window: a replayed delivery is a DUPLICATE in the inbox (keyed by the event id), and processing
// always re-fetches the subscription (the payload's state is never trusted).
//
// CCP-C5 — no tax parameter is ever sent (none exists in any request below); the C5 guard pins the
// readers of the key to this file (and the Razorpay catalog writer, through the exported readers).

export const RAZORPAY_SUBSCRIPTION_TOTAL_COUNT = 120;
export const RAZORPAY_DEFAULT_API_BASE = 'https://api.razorpay.com';

/** An injectable fetch (tests pass a fake; the default is the global fetch). */
export type RazorpayFetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * The Razorpay key, read in ONE place (this adapter; the CCP-C5 guard C5-G-1 holds the readers of the
 * key to this file). The catalog writer reuses these rather than reading the key or naming the host.
 */
export function razorpayCredentials(): { key_id: string; key_secret: string } | undefined {
  const key_id = process.env['RAZORPAY_KEY_ID']?.trim() ?? '';
  const key_secret = process.env['RAZORPAY_KEY_SECRET']?.trim() ?? '';
  return key_id === '' || key_secret === '' ? undefined : { key_id, key_secret };
}

export function razorpayApiBase(): string {
  const v = process.env['RAZORPAY_API_BASE']?.trim();
  return (v === undefined || v === '' ? RAZORPAY_DEFAULT_API_BASE : v).replace(/\/+$/, '');
}

function razorpayWebhookSecret(): string | undefined {
  const s = process.env['RAZORPAY_WEBHOOK_SECRET']?.trim();
  return s === undefined || s === '' ? undefined : s;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asDate(v: unknown): Date {
  return new Date(typeof v === 'number' ? v * 1000 : 0);
}

/**
 * Razorpay subscription status → the provider vocabulary `mapProviderStatus`
 * (subscription-lifecycle.service.ts) understands, so no second status machine exists (as the store
 * states do, store/store-state.ts):
 *
 *   Razorpay       meaning                                         provider_status     Aramo
 *   created        link made, mandate not yet authorized           incomplete          INCOMPLETE
 *   authenticated  mandate authorized, first charge not yet made   incomplete          INCOMPLETE
 *   active         charged, renewing                               active              ACTIVE
 *   pending        a renewal charge failed, Razorpay is retrying   past_due            PAST_DUE (grace)
 *   halted         every retry failed; no further charge           unpaid              PAST_DUE, not sending
 *   paused         paused by the merchant                          paused              PAST_DUE, not sending
 *   cancelled      cancelled (now, or at the cycle end reached)    canceled            CANCELED, ended
 *   completed      every billing cycle (total_count) was charged   canceled            CANCELED, ended
 *   expired        never authorized before the link expired        incomplete_expired  CANCELED, ended
 *   (anything else)                                                incomplete          INCOMPLETE (fail closed)
 */
export const RAZORPAY_STATUS_MAP: Readonly<Record<string, string>> = Object.freeze({
  created: 'incomplete',
  authenticated: 'incomplete',
  active: 'active',
  pending: 'past_due',
  halted: 'unpaid',
  paused: 'paused',
  cancelled: 'canceled',
  completed: 'canceled',
  expired: 'incomplete_expired',
});

export function razorpayProviderStatus(status: unknown): string {
  return typeof status === 'string' ? (RAZORPAY_STATUS_MAP[status] ?? 'incomplete') : 'incomplete';
}

/** A Razorpay subscription object → the provider subscription state. */
export function razorpaySubscriptionState(obj: Record<string, unknown>): ProviderSubscriptionState {
  const notes = obj['notes'] !== null && typeof obj['notes'] === 'object' && !Array.isArray(obj['notes']) ? (obj['notes'] as Record<string, unknown>) : {};
  const quantity = obj['quantity'];
  // A cancel scheduled for the cycle end leaves the subscription `active` until then; Razorpay
  // reports it on the object when it does (truthy), absent otherwise.
  const atCycleEnd = obj['cancel_at_cycle_end'];
  return {
    provider: 'RAZORPAY',
    subscription_ref: String(obj['id']),
    account_ref: razorpayWireAccountRef(obj),
    provider_status: razorpayProviderStatus(obj['status']),
    current_period_start: asDate(obj['current_start']),
    current_period_end: asDate(obj['current_end']),
    cancel_at_period_end: atCycleEnd === true || atCycleEnd === 1,
    // The Razorpay plan is the price (the version pin's provider_price_ref holds the plan id).
    price_ref: asString(obj['plan_id']),
    tenant_id: asString(notes['tenant_id']),
    intent_id: asString(notes['intent_id']),
    // Razorpay holds no billing address on a subscription: the activation country is decided by
    // the region (India Billing WS-D), never read from the provider. Null fails the US-only guard closed.
    account_country: null,
    // No subscription items on Razorpay: the quantity is on the subscription itself.
    item_ref: null,
    quantity: typeof quantity === 'number' && Number.isSafeInteger(quantity) && quantity >= 1 ? quantity : null,
  };
}

/** The checkout-session view of a subscription in the Stripe session vocabulary (open | complete | expired). */
export function razorpayCheckoutSessionState(obj: Record<string, unknown>): ProviderCheckoutSessionState {
  const s = razorpaySubscriptionState(obj);
  const raw = obj['status'];
  const paid = typeof obj['paid_count'] === 'number' && obj['paid_count'] > 0;
  // A link never paid and no longer payable (expired, or cancelled before any charge) is an expired session.
  const status = raw === 'created' ? 'open' : raw === 'expired' || (raw === 'cancelled' && !paid) ? 'expired' : 'complete';
  return { provider: 'RAZORPAY', session_ref: s.subscription_ref, status, tenant_id: s.tenant_id, intent_id: s.intent_id };
}

/** X-Razorpay-Signature check: hex HMAC-SHA256 of the raw body, compared in constant time. */
export function verifyRazorpaySignature(rawBody: Buffer, header: string | undefined, secret: string | undefined): void {
  if (secret === undefined || secret.length === 0) throw new BillingWebhookSignatureError('NO_SECRET');
  if (header === undefined || header.trim().length === 0) throw new BillingWebhookSignatureError('MISSING');
  const provided = header.trim();
  if (!/^[0-9a-f]{64}$/i.test(provided)) throw new BillingWebhookSignatureError('MALFORMED');
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'utf8');
  const got = Buffer.from(provided.toLowerCase(), 'utf8');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new BillingWebhookSignatureError('BAD_SIGNATURE');
}

/** The event id: the X-Razorpay-Event-Id header when sent, else a stable hash of the payload's identity. */
export function razorpayEventId(header: string | undefined, entity_id: string | null, event: string, created_at: unknown): string {
  const h = header?.trim();
  if (h !== undefined && /^[A-Za-z0-9_.:-]{1,128}$/.test(h)) return h;
  return `rzp_evt_${createHash('sha256').update(`${entity_id ?? ''}|${event}|${String(created_at ?? '')}`).digest('hex').slice(0, 32)}`;
}

@Injectable()
export class RazorpayBillingProvider implements BillingProviderPort, BillingProviderCommandPort, BillingProviderSeatPort {
  readonly provider = 'RAZORPAY' as const;

  constructor(private readonly fetchImpl: RazorpayFetch = (url, init) => fetch(url, init)) {}

  mode(): 'test' | 'live' {
    return (razorpayCredentials()?.key_id ?? '').startsWith('rzp_live_') ? 'live' : 'test';
  }

  /** G-2 — all three secrets set. */
  isConfigured(): boolean {
    return razorpayCredentials() !== undefined && razorpayWebhookSecret() !== undefined;
  }

  private async call(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const creds = razorpayCredentials();
    if (creds === undefined) throw new BillingProviderUnavailableError('Razorpay credentials are not configured');
    let res: Response;
    try {
      res = await this.fetchImpl(`${razorpayApiBase()}${path}`, {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(`${creds.key_id}:${creds.key_secret}`, 'utf8').toString('base64')}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new BillingProviderUnavailableError(`network: ${(err as Error).message}`, true);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const message = ((json['error'] as { description?: string } | undefined)?.description ?? `HTTP ${res.status}`).slice(0, 300);
      // As Stripe: a 4xx (other than 429) is the provider refusing this request — not retryable.
      const retryable = res.status === 429 || res.status >= 500;
      throw new BillingProviderUnavailableError(`razorpay ${method} ${path}: ${message}`, retryable);
    }
    return json;
  }

  /** The billing account (name, email, Aramo tenant). No address or registration field is sent (CCP-C5). */
  async upsertBillingAccount(account_ref: string | null, details: BillingAccountDetails): Promise<string> {
    const body =
      account_ref === null
        ? // fail_existing 0 — an account with the same email is returned rather than refused, so a retry
          // never makes a second account.
          { name: details.legal_name, email: details.billing_email, fail_existing: '0', notes: { tenant_id: details.tenant_id } }
        : { name: details.legal_name, email: details.billing_email };
    const a = await this.call(account_ref === null ? 'POST' : 'PUT', razorpayWireAccountPath(account_ref), body);
    const id = asString(a['id']);
    if (id === null) throw new BillingProviderUnavailableError('billing account without id');
    return id;
  }

  /**
   * The hosted authorization link. `price_ref` is the Razorpay plan id (the version pin). Razorpay has
   * no return URL, address collection or submit text on a subscription link: success_url / cancel_url,
   * collect_address and disclosure are not sent (the renewal disclosure is shown by Aramo before the
   * redirect — India Billing WS-D).
   */
  async createCheckoutSession(req: CheckoutSessionRequest): Promise<{ session_ref: string; url: string }> {
    const quantity = req.quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new BillingProviderUnavailableError('quantity must be a positive integer', false);
    const s = await this.call('POST', '/v1/subscriptions', {
      plan_id: req.price_ref,
      total_count: RAZORPAY_SUBSCRIPTION_TOTAL_COUNT,
      quantity,
      ...razorpayWireSubscriptionAccountFields(req.account_ref),
      notes: { tenant_id: req.tenant_id, intent_id: req.intent_id, user_id: req.user_id },
    });
    const url = asString(s['short_url']);
    const id = asString(s['id']);
    if (url === null || id === null) throw new BillingProviderUnavailableError('subscription link without id/url');
    return { session_ref: id, url };
  }

  /**
   * Razorpay has no hosted billing portal: the caller's return URL (Aramo's own billing settings page,
   * where cancel and seats are managed) is returned, with no provider call.
   */
  async createPortalSession(_account_ref: string, return_url: string): Promise<{ url: string }> {
    return { url: return_url };
  }

  async retrieveSubscription(subscription_ref: string): Promise<ProviderSubscriptionState> {
    return razorpaySubscriptionState(await this.call('GET', `/v1/subscriptions/${encodeURIComponent(subscription_ref)}`));
  }

  /**
   * Razorpay cancels by its own endpoint. No idempotency key is sent (the subscription API takes none):
   * a repeated cancel is refused by Razorpay, never doubled, and the command re-reads the state first.
   */
  async cancelSubscription(subscription_ref: string, opts: { at_period_end: boolean }): Promise<void> {
    await this.call('POST', `/v1/subscriptions/${encodeURIComponent(subscription_ref)}/cancel`, { cancel_at_cycle_end: opts.at_period_end ? 1 : 0 });
  }

  /** A checkout "session" is the not-yet-authorized subscription: expiring it cancels it now. */
  async expireCheckoutSession(session_ref: string): Promise<void> {
    await this.cancelSubscription(session_ref, { at_period_end: false });
  }

  async retrieveCheckoutSession(session_ref: string): Promise<ProviderCheckoutSessionState> {
    return razorpayCheckoutSessionState(await this.call('GET', `/v1/subscriptions/${encodeURIComponent(session_ref)}`));
  }

  /**
   * Seats — the subscription quantity. `create_prorations` (an increase) applies now; `none` (a
   * decrease, or restoring the paid quantity) from the next cycle. Returns the state re-read after.
   */
  async updateSubscriptionQuantity(subscription_ref: string, quantity: number, proration: SeatProrationBehavior): Promise<ProviderSubscriptionState> {
    if (!Number.isSafeInteger(quantity) || quantity < 1) throw new BillingProviderUnavailableError('seat quantity must be a positive integer', false);
    const path = `/v1/subscriptions/${encodeURIComponent(subscription_ref)}`;
    await this.call('PATCH', path, { quantity, schedule_change_at: proration === 'create_prorations' ? 'now' : 'cycle_end' });
    return razorpaySubscriptionState(await this.call('GET', path));
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined, _nowSec: number, context?: { event_id?: string | undefined }): VerifiedBillingEvent {
    verifyRazorpaySignature(rawBody, signatureHeader, razorpayWebhookSecret());
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new BillingWebhookSignatureError('MALFORMED');
    }
    const type = evt['event'];
    const payload = evt['payload'];
    if (typeof type !== 'string' || type === '' || payload === null || typeof payload !== 'object') throw new BillingWebhookSignatureError('MALFORMED');
    const entity = (name: string): Record<string, unknown> | null => {
      const e = ((payload as Record<string, unknown>)[name] as { entity?: unknown } | undefined)?.entity;
      return e !== null && typeof e === 'object' ? (e as Record<string, unknown>) : null;
    };
    const sub = entity('subscription');
    const payment = entity('payment');
    // The subscription the event concerns: a subscription.* event's entity, else a payment's link.
    const subscription_ref = asString(sub?.['id']) ?? asString(payment?.['subscription_id']);
    const object_ref = subscription_ref === null ? asString(payment?.['id']) : null;
    return {
      provider: 'RAZORPAY',
      id: razorpayEventId(context?.event_id, subscription_ref ?? object_ref, type, evt['created_at']),
      type,
      created: asDate(evt['created_at']),
      subscription_ref,
      ...(object_ref !== null ? { object_ref } : {}),
    };
  }
}
