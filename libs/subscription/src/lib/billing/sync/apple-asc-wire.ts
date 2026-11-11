// CCP Billing Products — the App Store Connect WIRE boundary: the ONLY place an Apple-defined field
// name that the vocabulary gate restricts appears (the price-point price attribute). This file is
// file-scoped exempt from the vocabulary gate (PO ruling 2026-11-11, the stripe-wire.ts vendor-
// integration precedent, same restrictions) and therefore holds NO Aramo-owned logic — only
// translation from Apple's attribute to Aramo's own name, `amount`. Everything else lives in
// apple-asc.client.ts, which the gate fully enforces.

/** An App Store Connect price point's attributes → the price it charges (a decimal string), or null. */
export function wirePricePointAmount(attributes: Record<string, unknown> | undefined): string | null {
  const v = attributes?.['customerPrice'];
  return typeof v === 'string' && v !== '' ? v : null;
}

/** The inverse: Aramo's `amount` (a decimal string) → Apple's price-point attributes (test fakes build responses with it). */
export function wirePricePointAttributes(amount: string): Record<string, unknown> {
  return { customerPrice: amount };
}
