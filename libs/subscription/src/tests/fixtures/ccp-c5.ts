import type { AccountView } from '../../lib/billing/subscription-lifecycle.service.js';
import { TAX_NOT_ENABLED_REASON } from '../../lib/billing/tax-availability.js';

// CCP-C5 — the Sign equality goldens (ccp-a4-sign-equality.golden.json, captured on the baseline
// code b0e59aa6) predate the additive `tax` field on the account read. The replay adapters strip it
// here, after checking that it is exactly the designed disabled state, so the goldens stay
// byte-for-byte proofs of unchanged Sign allowance, capacity and account semantics.
export function withoutDisabledTax(view: AccountView): Omit<AccountView, 'tax'> {
  const { tax, ...rest } = view;
  if (tax.enabled !== false || tax.reason !== TAX_NOT_ENABLED_REASON || Object.keys(tax).length !== 2) {
    throw new Error(`CCP-C5: the account read must carry the disabled tax state, got ${JSON.stringify(tax)}`);
  }
  return rest;
}

// Sign Business per-seat pricing (directive v1.0 §3.3.4) — the account read gains the additive
// `price_unit` (the shown subscription's pinned price unit; null without one). The equality corpus
// skips the per-seat catalog data, so every corpus account is per account: the replay adapters strip
// the field after checking exactly that, and the goldens stay byte-for-byte proofs.
export function withoutAccountPriceUnit<V extends { price_unit: AccountView['price_unit'] }>(view: V): Omit<V, 'price_unit'> {
  const { price_unit, ...rest } = view;
  if (price_unit !== null && price_unit !== 'ACCOUNT') {
    throw new Error(`per-seat: an equality-corpus account must be priced per account, got ${JSON.stringify(price_unit)}`);
  }
  return rest;
}
