import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  type PaymentAccountState,
  type PaymentCheckoutRequest,
  type PaymentCheckoutState,
  type PaymentProviderPort,
  PaymentProviderRefusedError,
  PaymentProviderUnavailableError,
  type PaymentRefundRequest,
  type PaymentRefundState,
  PaymentWebhookSignatureError,
  type VerifiedPaymentEvent,
} from '@aramo/sign';

import { signStripeConnectConfig, type SignStripeConnectConfig } from './sign-payments.config.js';

// Aramo Sign 1.14 — the Stripe Connect adapter of the payment port (D-3 default vendor),
// over Stripe's REST API (no SDK, like the billing adapter).
//
// SEPARATE from Aramo's own billing account: its keys are SIGN_STRIPE_CONNECT_* (never
// STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET), and its webhook endpoint is a Connect
// endpoint (events from connected accounts carry `account`).
//
// R-6 / PCI — why this cannot put Aramo in the funds flow:
//   - accounts are Stripe STANDARD accounts: the subscriber owns the account, its balance,
//     payouts, disputes and refunds liability;
//   - every checkout and refund is a DIRECT charge made with the `Stripe-Account` header
//     (on the connected account): funds settle to the subscriber's balance, never Aramo's;
//   - the payer pays on Stripe's hosted Checkout page (a redirect): card data never touches
//     an Aramo page or server;
//   - the only amount that can reach Aramo is `application_fee_amount`, sent only when the
//     configured fee is above 0 (default 0).
// Webhooks: Stripe-Signature `t=<unix>,v1=<hex>` = HMAC-SHA256(secret, `${t}.${raw}`),
// verified in constant time within ±300 s before anything is parsed.

export const SIGN_STRIPE_API_VERSION = '2024-06-20';
export const SIGN_STRIPE_WEBHOOK_TOLERANCE_SEC = 300;

function form(params: Record<string, string | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
    .join('&');
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);
const ref = (v: unknown): string | null => str(v) ?? str((v as { id?: unknown } | null | undefined)?.id);
const obj = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export function accountState(a: Record<string, unknown>, live: boolean): PaymentAccountState {
  const id = str(a['id']);
  if (id === null) throw new PaymentProviderUnavailableError('account without id');
  return {
    account_ref: id,
    charges_enabled: a['charges_enabled'] === true,
    details_submitted: a['details_submitted'] === true,
    payouts_enabled: a['payouts_enabled'] === true,
    live,
  };
}

export function checkoutState(s: Record<string, unknown>): PaymentCheckoutState {
  const id = str(s['id']);
  if (id === null) throw new PaymentProviderUnavailableError('checkout without id');
  const status = s['status'] === 'complete' ? 'COMPLETE' : s['status'] === 'expired' ? 'EXPIRED' : 'OPEN';
  const metadata = obj(s['metadata']);
  return {
    checkout_ref: id,
    url: str(s['url']),
    status,
    paid: s['payment_status'] === 'paid',
    payment_ref: ref(s['payment_intent']),
    amount_minor: int(s['amount_total']),
    currency: str(s['currency'])?.toUpperCase() ?? null,
    payment_id: str(metadata['aramo_payment_id']) ?? str(s['client_reference_id']),
    live: s['livemode'] === true,
  };
}

export function refundState(r: Record<string, unknown>): PaymentRefundState & { payment_ref: string | null } {
  const id = str(r['id']);
  if (id === null) throw new PaymentProviderUnavailableError('refund without id');
  const raw = str(r['status']);
  const status = raw === 'succeeded' ? 'SUCCEEDED' : raw === 'failed' ? 'FAILED' : raw === 'canceled' ? 'CANCELED' : 'PENDING';
  return { refund_ref: id, status, amount_minor: int(r['amount']), refund_id: str(obj(r['metadata'])['aramo_refund_id']), payment_ref: ref(r['payment_intent']) };
}

export function verifyConnectSignature(rawBody: Buffer, header: string | undefined, secret: string | undefined, nowSec: number): void {
  if (secret === undefined || secret.length === 0) throw new PaymentWebhookSignatureError('NO_SECRET');
  if (header === undefined || header.length === 0) throw new PaymentWebhookSignatureError('MISSING');
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
  if (t === null || !/^\d{1,12}$/.test(t) || sigs.length === 0) throw new PaymentWebhookSignatureError('MALFORMED');
  if (Math.abs(nowSec - Number(t)) > SIGN_STRIPE_WEBHOOK_TOLERANCE_SEC) throw new PaymentWebhookSignatureError('STALE');
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex'), 'utf8');
  const ok = sigs.some((s) => {
    const provided = Buffer.from(s, 'utf8');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
  if (!ok) throw new PaymentWebhookSignatureError('BAD_SIGNATURE');
}

@Injectable()
export class StripeConnectPaymentProvider implements PaymentProviderPort {
  // Read on every call (never cached), so the keys are only ever in the environment.
  protected config(): SignStripeConnectConfig {
    return signStripeConnectConfig();
  }

  configured(): boolean {
    const c = this.config();
    return c.secret_key !== null && c.webhook_secret !== null;
  }

  private live(): boolean {
    const k = this.config().secret_key ?? '';
    return k.startsWith('sk_live_') || k.startsWith('rk_live_');
  }

  private async call(method: 'GET' | 'POST', path: string, opts: { body?: string; account_ref?: string; idempotency_key?: string } = {}): Promise<Record<string, unknown>> {
    const c = this.config();
    if (c.secret_key === null) throw new PaymentProviderUnavailableError('SIGN_STRIPE_CONNECT_SECRET_KEY is not configured');
    let res: Response;
    try {
      res = await fetch(`${c.api_base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${c.secret_key}`,
          'stripe-version': SIGN_STRIPE_API_VERSION,
          ...(opts.body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(opts.account_ref !== undefined ? { 'stripe-account': opts.account_ref } : {}),
          ...(opts.idempotency_key !== undefined ? { 'idempotency-key': opts.idempotency_key } : {}),
        },
        body: opts.body,
      });
    } catch (err) {
      throw new PaymentProviderUnavailableError(`network: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const message = (obj(json['error'])['message'] as string | undefined ?? `HTTP ${res.status}`).slice(0, 300);
      if (res.status === 429 || res.status >= 500) throw new PaymentProviderUnavailableError(`stripe ${method} ${path}: ${message}`);
      throw new PaymentProviderRefusedError(`stripe ${method} ${path}: ${message}`, res.status);
    }
    return json;
  }

  async createAccount(input: { tenant_id: string; email: string | null; idempotency_key: string }): Promise<PaymentAccountState> {
    const a = await this.call('POST', '/v1/accounts', {
      body: form({ type: 'standard', email: input.email ?? undefined, 'metadata[tenant_id]': input.tenant_id }),
      idempotency_key: input.idempotency_key,
    });
    return accountState(a, this.live());
  }

  async getAccount(account_ref: string): Promise<PaymentAccountState> {
    return accountState(await this.call('GET', `/v1/accounts/${encodeURIComponent(account_ref)}`), this.live());
  }

  async createOnboardingLink(input: { account_ref: string; refresh_url: string; return_url: string }): Promise<{ url: string; expires_at: Date }> {
    const l = await this.call('POST', '/v1/account_links', {
      body: form({ account: input.account_ref, refresh_url: input.refresh_url, return_url: input.return_url, type: 'account_onboarding' }),
    });
    const url = str(l['url']);
    if (url === null) throw new PaymentProviderUnavailableError('onboarding link without url');
    return { url, expires_at: new Date(int(l['expires_at']) * 1000) };
  }

  async createCheckout(input: PaymentCheckoutRequest): Promise<PaymentCheckoutState> {
    const meta = {
      'metadata[aramo_payment_id]': input.references.payment_id,
      'metadata[tenant_id]': input.references.tenant_id,
      'metadata[envelope_id]': input.references.envelope_id,
      'metadata[field_id]': input.references.field_id,
    };
    const s = await this.call('POST', '/v1/checkout/sessions', {
      account_ref: input.account_ref,
      idempotency_key: input.idempotency_key,
      body: form({
        mode: 'payment',
        client_reference_id: input.references.payment_id,
        success_url: input.success_url,
        cancel_url: input.cancel_url,
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': input.currency.toLowerCase(),
        'line_items[0][price_data][unit_amount]': String(input.amount_minor),
        'line_items[0][price_data][product_data][name]': input.description.slice(0, 250) || 'Payment',
        ...meta,
        'payment_intent_data[metadata][aramo_payment_id]': input.references.payment_id,
        'payment_intent_data[metadata][tenant_id]': input.references.tenant_id,
        ...(input.application_fee_minor > 0 ? { 'payment_intent_data[application_fee_amount]': String(input.application_fee_minor) } : {}),
      }),
    });
    return checkoutState(s);
  }

  async getCheckout(account_ref: string, checkout_ref: string): Promise<PaymentCheckoutState> {
    return checkoutState(await this.call('GET', `/v1/checkout/sessions/${encodeURIComponent(checkout_ref)}`, { account_ref }));
  }

  async createRefund(input: PaymentRefundRequest): Promise<PaymentRefundState> {
    const r = await this.call('POST', '/v1/refunds', {
      account_ref: input.account_ref,
      idempotency_key: input.idempotency_key,
      body: form({
        payment_intent: input.payment_ref,
        amount: String(input.amount_minor),
        // A refund also returns Aramo's proportional application fee (if one was taken).
        ...(input.refund_application_fee ? { refund_application_fee: 'true' } : {}),
        'metadata[aramo_refund_id]': input.references.refund_id,
        'metadata[aramo_payment_id]': input.references.payment_id,
        'metadata[tenant_id]': input.references.tenant_id,
      }),
    });
    return refundState(r);
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined, now: Date = new Date()): VerifiedPaymentEvent {
    verifyConnectSignature(rawBody, signatureHeader, this.config().webhook_secret ?? undefined, Math.floor(now.getTime() / 1000));
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new PaymentWebhookSignatureError('MALFORMED_BODY');
    }
    return translateEvent(evt);
  }
}

/** A verified Stripe event → Aramo's payment event kinds. */
export function translateEvent(evt: Record<string, unknown>): VerifiedPaymentEvent {
  const event_ref = str(evt['id']);
  const event_type = str(evt['type']);
  if (event_ref === null || event_type === null) throw new PaymentWebhookSignatureError('MALFORMED_BODY');
  const account_ref = str(evt['account']);
  const object = obj(obj(evt['data'])['object']);
  const live = evt['livemode'] === true;
  const base = { event_ref, event_type, account_ref };
  switch (event_type) {
    case 'account.updated':
      return { ...base, kind: 'ACCOUNT_UPDATED', account: accountState(object, live) };
    case 'account.application.deauthorized':
      return { ...base, kind: 'ACCOUNT_DEAUTHORIZED' };
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return { ...base, kind: 'CHECKOUT_COMPLETED', checkout: checkoutState(object) };
    case 'checkout.session.async_payment_failed':
      return { ...base, kind: 'CHECKOUT_PAYMENT_FAILED', checkout: checkoutState(object) };
    case 'checkout.session.expired':
      return { ...base, kind: 'CHECKOUT_EXPIRED', checkout: checkoutState(object) };
    case 'charge.refunded': {
      const payment_ref = ref(object['payment_intent']);
      if (payment_ref === null) return { ...base, kind: 'OTHER' };
      return { ...base, kind: 'CHARGE_REFUNDED', charge: { payment_ref, amount_minor: int(object['amount']), amount_refunded_minor: int(object['amount_refunded']) } };
    }
    case 'refund.created':
    case 'refund.updated':
    case 'refund.failed':
      return { ...base, kind: 'REFUND_UPDATED', refund: refundState(object) };
    default:
      return { ...base, kind: 'OTHER' };
  }
}
