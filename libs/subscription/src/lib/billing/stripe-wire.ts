// Aramo Sign launch — the Stripe WIRE boundary: the ONLY place Stripe's
// vendor-defined identifiers appear (its account-object field and checkout /
// portal parameter names, and its subscription event-type prefix). This file is
// file-scoped exempt from the vocabulary gate (Architect ruling: vendor-
// integration exception, approved with restrictions) and therefore holds NO
// Aramo-owned logic — only translation to and from Aramo's own name,
// `account_ref`. Everything else lives in stripe-billing.provider.ts, which the
// gate fully enforces.

/** Stripe object → Aramo `account_ref` (the field is a string id or an expanded object). */
export function wireAccountRef(obj: Record<string, unknown>): string {
  const v = obj['customer'];
  if (typeof v === 'string') return v;
  return String((v as { id?: unknown } | null)?.id ?? '');
}

/**
 * Aramo `account_ref` (or, for a first checkout, the owner email) → Stripe checkout
 * params. Sign Signup A1 §2.6: on Aramo's billing account the address is NOT
 * updatable in Checkout (the registered US address stays the billing address;
 * the country is still re-verified on every sync).
 */
export function wireCheckoutAccountParams(account_ref: string | null, owner_email: string): Record<string, string> {
  return account_ref !== null ? { customer: account_ref, 'customer_update[address]': 'never' } : { customer_email: owner_email };
}

/** Sign Signup A1 §2.6 — the Stripe path that creates (null) or updates the billing account. */
export function wireAccountPath(account_ref: string | null): string {
  return account_ref === null ? '/v1/customers' : `/v1/customers/${encodeURIComponent(account_ref)}`;
}

/** Sign Signup A1 §2.6 — Aramo billing-account details → Stripe account params. */
export function wireAccountParams(details: {
  tenant_id: string;
  legal_name: string;
  billing_email: string;
  address: { line1: string; line2: string | null; city: string; state: string; postal_code: string; country: string };
}): Record<string, string> {
  return {
    name: details.legal_name,
    email: details.billing_email,
    'address[line1]': details.address.line1,
    // An empty value clears a previously stored line 2 on update.
    'address[line2]': details.address.line2 ?? '',
    'address[city]': details.address.city,
    'address[state]': details.address.state,
    'address[postal_code]': details.address.postal_code,
    'address[country]': details.address.country,
    'metadata[tenant_id]': details.tenant_id,
  };
}

/** Sign Signup A1 §2.6 — the subscription read expands the billing account (its address). */
export function wireSubscriptionQuery(): string {
  return `${encodeURIComponent('expand[]')}=customer`;
}

/** Stripe subscription (with the account expanded) → the account's billing country, or null. */
export function wireAccountCountry(obj: Record<string, unknown>): string | null {
  const v = obj['customer'];
  if (v === null || typeof v !== 'object') return null;
  const country = (v as { address?: { country?: unknown } | null }).address?.country;
  return typeof country === 'string' && country.trim() !== '' ? country.trim() : null;
}

/** Aramo `account_ref` → Stripe billing-portal params. */
export function wirePortalAccountParams(account_ref: string): Record<string, string> {
  return { customer: account_ref };
}

/** Stripe subscription lifecycle events (created / updated / deleted / paused / resumed …). */
export function isWireSubscriptionEvent(type: string): boolean {
  return type.startsWith('customer.subscription.');
}

// ---------------------------------------------------------------------------------------
// CCP-C3 (PBD §5.2 row C3) — read-through invoice / payment status and the portal
// configuration. Pure translation of Stripe READ shapes (paths, list query, object fields) to
// Aramo's own names; no Aramo-owned logic (payment-state derivation lives in
// billing-status-read.service.ts, which the gate fully enforces). Every path below is read with
// GET only (stripe-billing-read.adapter.ts).
// ---------------------------------------------------------------------------------------

const wireRef = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : typeof (v as { id?: unknown } | null)?.id === 'string' ? ((v as { id: string }).id || null) : null;
const wireStr = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const wireInt = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0);
const wireTime = (v: unknown): Date | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? new Date(v * 1000) : null);
const wireFlag = (v: unknown): boolean => (v as { enabled?: unknown } | null | undefined)?.enabled === true;

/** The Stripe invoice list for ONE subscription (newest first; Stripe caps `limit` at 100). */
export function wireInvoiceListPath(subscription_ref: string, limit: number): string {
  const n = Math.min(Math.max(Math.trunc(limit), 1), 100);
  return `/v1/invoices?subscription=${encodeURIComponent(subscription_ref)}&limit=${n}`;
}

/** One Stripe billing-portal configuration. */
export function wirePortalConfigurationPath(configuration_ref: string): string {
  return `/v1/billing_portal/configurations/${encodeURIComponent(configuration_ref)}`;
}

/** A Stripe list envelope → its objects. */
export function wireListData(obj: Record<string, unknown>): Array<Record<string, unknown>> {
  const data = obj['data'];
  return Array.isArray(data) ? data.filter((d): d is Record<string, unknown> => d !== null && typeof d === 'object') : [];
}

/** A Stripe invoice → Aramo's invoice status mirror (amounts in the currency's minor unit, as Stripe holds them). */
export function wireInvoiceState(obj: Record<string, unknown>): {
  invoice_ref: string;
  number: string | null;
  account_ref: string;
  subscription_ref: string | null;
  provider_status: string;
  currency: string | null;
  total_minor: number;
  amount_due_minor: number;
  amount_paid_minor: number;
  amount_remaining_minor: number;
  created_at: Date | null;
  due_at: Date | null;
  period_start: Date | null;
  period_end: Date | null;
  attempt_count: number;
  next_attempt_at: Date | null;
  hosted_url: string | null;
  document_url: string | null;
  live: boolean;
} {
  const parent = obj['parent'] as { subscription_details?: { subscription?: unknown } } | null | undefined;
  return {
    invoice_ref: String(obj['id'] ?? ''),
    number: wireStr(obj['number']),
    account_ref: wireAccountRef(obj),
    // Pinned API version: invoice.subscription; newer versions: parent.subscription_details.subscription.
    subscription_ref: wireRef(obj['subscription']) ?? wireRef(parent?.subscription_details?.subscription),
    provider_status: String(obj['status'] ?? ''),
    currency: wireStr(obj['currency']),
    total_minor: wireInt(obj['total']),
    amount_due_minor: wireInt(obj['amount_due']),
    amount_paid_minor: wireInt(obj['amount_paid']),
    amount_remaining_minor: wireInt(obj['amount_remaining']),
    created_at: wireTime(obj['created']),
    due_at: wireTime(obj['due_date']),
    period_start: wireTime(obj['period_start']),
    period_end: wireTime(obj['period_end']),
    attempt_count: wireInt(obj['attempt_count']),
    next_attempt_at: wireTime(obj['next_payment_attempt']),
    hosted_url: wireStr(obj['hosted_invoice_url']),
    document_url: wireStr(obj['invoice_pdf']),
    live: obj['livemode'] === true,
  };
}

/** A Stripe billing-portal configuration → Aramo's portal-configuration facts. */
export function wirePortalConfigurationState(obj: Record<string, unknown>): {
  configuration_ref: string;
  active: boolean;
  is_default: boolean;
  live: boolean;
  invoice_history_enabled: boolean;
  payment_method_update_enabled: boolean;
  subscription_cancel_enabled: boolean;
  subscription_cancel_mode: string | null;
  subscription_update_enabled: boolean;
} {
  const f = (obj['features'] as Record<string, unknown> | null | undefined) ?? {};
  return {
    configuration_ref: String(obj['id'] ?? ''),
    active: obj['active'] === true,
    is_default: obj['is_default'] === true,
    live: obj['livemode'] === true,
    invoice_history_enabled: wireFlag(f['invoice_history']),
    payment_method_update_enabled: wireFlag(f['payment_method_update']),
    subscription_cancel_enabled: wireFlag(f['subscription_cancel']),
    subscription_cancel_mode: wireStr((f['subscription_cancel'] as { mode?: unknown } | null | undefined)?.mode),
    subscription_update_enabled: wireFlag(f['subscription_update']),
  };
}

// ---------------------------------------------------------------------------------------
// CCP-C4 (PBD §5.2 row C4) — the billing adjustments (credits, discounts, refunds). Pure
// translation of Stripe WRITE params and READ shapes to Aramo's own names; no Aramo-owned logic
// (the adjustment rules live in billing-command.service.ts and the commercial C4 files). Every
// write's metadata names the Aramo command (the re-read key) and the tenant (the tenant check).
// ---------------------------------------------------------------------------------------

/** Aramo command + tenant → Stripe metadata params. */
export function wireAdjustmentMetadata(command_id: string, tenant_id: string): Record<string, string> {
  return { 'metadata[aramo_command_id]': command_id, 'metadata[tenant_id]': tenant_id };
}

const wireMeta = (obj: Record<string, unknown>): Record<string, unknown> => (obj['metadata'] as Record<string, unknown> | null | undefined) ?? {};

/** A signed balance adjustment (negative = a credit the next invoice draws on). */
export function wireBalanceAdjustmentParams(signed_amount_minor: number, currency: string, req: { command_id: string; tenant_id: string }): Record<string, string> {
  return { amount: String(signed_amount_minor), currency: currency.toLowerCase(), ...wireAdjustmentMetadata(req.command_id, req.tenant_id) };
}

/** A Stripe balance transaction → Aramo's adjustment facts. */
export function wireBalanceAdjustmentState(obj: Record<string, unknown>): { object_ref: string | null; amount_minor: number; currency: string | null; command_id: string | null; tenant_id: string | null; live: boolean } {
  const m = wireMeta(obj);
  return {
    object_ref: wireStr(obj['id']),
    amount_minor: wireInt(obj['amount']),
    currency: wireStr(obj['currency']),
    command_id: wireStr(m['aramo_command_id']),
    tenant_id: wireStr(m['tenant_id']),
    live: obj['livemode'] === true,
  };
}

/** A percent-off coupon with Aramo's deterministic id, for the next invoice only. */
export function wireCouponParams(coupon_ref: string, discount_bps: number, req: { command_id: string; tenant_id: string }): Record<string, string> {
  return { id: coupon_ref, percent_off: String(discount_bps / 100), duration: 'once', ...wireAdjustmentMetadata(req.command_id, req.tenant_id) };
}

/** Attach the coupon to the subscription. */
export function wireSubscriptionDiscountParams(coupon_ref: string): Record<string, string> {
  return { 'discounts[0][coupon]': coupon_ref };
}

/** A Stripe subscription → its current discount (coupon id and discount object id), or nulls. */
export function wireSubscriptionDiscount(obj: Record<string, unknown>): { coupon_ref: string | null; discount_ref: string | null } {
  const d = obj['discount'] as { id?: unknown; coupon?: unknown } | null | undefined;
  if (d === null || d === undefined || typeof d !== 'object') return { coupon_ref: null, discount_ref: null };
  return { coupon_ref: wireRef(d.coupon), discount_ref: wireStr(d.id) };
}

/** A Stripe invoice → the account that paid it and the payment a refund draws on. */
export function wireInvoicePayment(obj: Record<string, unknown>): { account_ref: string; payment_ref: string | null; currency: string | null; amount_paid_minor: number } {
  return { account_ref: wireAccountRef(obj), payment_ref: wireRef(obj['payment_intent']), currency: wireStr(obj['currency']), amount_paid_minor: wireInt(obj['amount_paid']) };
}

/** A refund of `amount_minor` of one payment. */
export function wireRefundParams(payment_ref: string, amount_minor: number, req: { command_id: string; tenant_id: string }): Record<string, string> {
  return { payment_intent: payment_ref, amount: String(amount_minor), ...wireAdjustmentMetadata(req.command_id, req.tenant_id) };
}

/** A Stripe refund → Aramo's refund facts. */
export function wireRefundState(obj: Record<string, unknown>): { object_ref: string | null; status: string | null; amount_minor: number; command_id: string | null; tenant_id: string | null; live: boolean } {
  const m = wireMeta(obj);
  return {
    object_ref: wireStr(obj['id']),
    status: wireStr(obj['status']),
    amount_minor: wireInt(obj['amount']),
    command_id: wireStr(m['aramo_command_id']),
    tenant_id: wireStr(m['tenant_id']),
    live: obj['livemode'] === true,
  };
}
