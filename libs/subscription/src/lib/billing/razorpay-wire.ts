// India Billing Regions + Razorpay (directive v1.0 LOCKED §4.5) — the Razorpay WIRE boundary: the
// ONLY place Razorpay's vendor-defined identifiers that the vocabulary gate would otherwise refuse
// appear (its account-object id field on a subscription, its subscription-create notify field and
// its account-object path). This file is file-scoped exempt from the vocabulary gate (PO ruling
// 2026-11-13, India Billing directive §3 Q4: the same vendor-integration exception as
// stripe-wire.ts, approved with the same restrictions) and therefore holds NO Aramo-owned logic —
// only translation to and from Aramo's own name, `account_ref`. Everything else lives in
// razorpay-billing.provider.ts, which the gate fully enforces.

/** Razorpay object (a subscription, or a webhook subscription entity) → Aramo `account_ref` ('' when absent). */
export function razorpayWireAccountRef(obj: Record<string, unknown>): string {
  const v = obj['customer_id'];
  return typeof v === 'string' ? v : '';
}

/**
 * The account fields of a subscription create: Razorpay notifies the payer with the hosted
 * authorization link (`1`), and the subscription is bound to the Aramo billing account when one
 * exists (`account_ref` → Razorpay's account-object id field).
 */
export function razorpayWireSubscriptionAccountFields(account_ref: string | null): Record<string, string | number> {
  return { customer_notify: 1, ...(account_ref !== null && account_ref !== '' ? { customer_id: account_ref } : {}) };
}

/** The Razorpay path that creates (null: POST) or updates (PUT) the billing account. */
export function razorpayWireAccountPath(account_ref: string | null): string {
  return account_ref === null ? '/v1/customers' : `/v1/customers/${encodeURIComponent(account_ref)}`;
}
