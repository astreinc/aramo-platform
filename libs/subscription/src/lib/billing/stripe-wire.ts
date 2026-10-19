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

/** Aramo `account_ref` (or, for a first checkout, the owner email) → Stripe checkout params. */
export function wireCheckoutAccountParams(account_ref: string | null, owner_email: string): Record<string, string> {
  return account_ref !== null ? { customer: account_ref } : { customer_email: owner_email };
}

/** Aramo `account_ref` → Stripe billing-portal params. */
export function wirePortalAccountParams(account_ref: string): Record<string, string> {
  return { customer: account_ref };
}

/** Stripe subscription lifecycle events (created / updated / deleted / paused / resumed …). */
export function isWireSubscriptionEvent(type: string): boolean {
  return type.startsWith('customer.subscription.');
}
