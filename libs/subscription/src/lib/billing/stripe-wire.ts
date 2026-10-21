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
