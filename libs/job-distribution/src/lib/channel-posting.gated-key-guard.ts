import type { ChannelPostingInput } from './channel-posting.types.js';

// SRC-2 PR-2 (R3) — COMPILE-TIME negative guard (type-level part of the R3
// negative test). Each array element adds ONE gated key to a valid input; the
// excess-property check rejects it, and @ts-expect-error asserts that rejection.
// If any gated key were ever added to ChannelPostingInput, the corresponding
// suppression directive would go UNUSED → a compile error.
//
// This lives in a BUILT source file (not a *.spec.ts) on purpose: this repo does
// not type-check spec files (no tsconfig.spec.json / vitest typecheck), so the
// assertion is enforced by `nx build` (tsc over tsconfig.lib.json). The runtime +
// import-boundary halves of the R3 negative test live in the spec. Erased at
// emit — never executed.

const base: ChannelPostingInput = {
  requisition_id: '',
  tenant_id: '',
  title: '',
  description: null,
  city: null,
  state_code: null,
  country: '',
  job_type: null,
  work_arrangement: null,
  openings: 0,
  advertised_pay_min: null,
  advertised_pay_max: null,
  advertised_pay_period: null,
  advertised_pay_currency: null,
  public_listing: false,
  posted_at: '',
  updated_at: '',
};

// The 13 compensation-map keys + the 7 financials-map keys — each structurally
// unrepresentable in ChannelPostingInput.
export const GATED_KEY_REJECTIONS: readonly ChannelPostingInput[] = [
  // @ts-expect-error pay_rate_amount is a gated compensation-map key
  { ...base, pay_rate_amount: '' },
  // @ts-expect-error pay_rate_currency is a gated compensation-map key
  { ...base, pay_rate_currency: '' },
  // @ts-expect-error pay_rate_period is a gated compensation-map key
  { ...base, pay_rate_period: '' },
  // @ts-expect-error bill_rate_amount is a gated compensation-map key
  { ...base, bill_rate_amount: '' },
  // @ts-expect-error bill_rate_currency is a gated compensation-map key
  { ...base, bill_rate_currency: '' },
  // @ts-expect-error bill_rate_period is a gated compensation-map key
  { ...base, bill_rate_period: '' },
  // @ts-expect-error placement_fee_percent is a gated compensation-map key
  { ...base, placement_fee_percent: '' },
  // @ts-expect-error placement_fee_amount is a gated compensation-map key
  { ...base, placement_fee_amount: '' },
  // @ts-expect-error salary_amount is a gated compensation-map key
  { ...base, salary_amount: '' },
  // @ts-expect-error salary_currency is a gated compensation-map key
  { ...base, salary_currency: '' },
  // @ts-expect-error margin_amount is a gated compensation-map key
  { ...base, margin_amount: '' },
  // @ts-expect-error markup_percent is a gated compensation-map key
  { ...base, markup_percent: '' },
  // @ts-expect-error margin_percent is a gated compensation-map key
  { ...base, margin_percent: '' },
  // @ts-expect-error target_margin_percent is a gated financials-map key
  { ...base, target_margin_percent: '' },
  // @ts-expect-error markup_percent_target is a gated financials-map key
  { ...base, markup_percent_target: '' },
  // @ts-expect-error rate_card_id is a gated financials-map key
  { ...base, rate_card_id: '' },
  // @ts-expect-error min_bill_rate is a gated financials-map key
  { ...base, min_bill_rate: '' },
  // @ts-expect-error max_bill_rate is a gated financials-map key
  { ...base, max_bill_rate: '' },
  // @ts-expect-error min_pay_rate is a gated financials-map key
  { ...base, min_pay_rate: '' },
  // @ts-expect-error max_pay_rate is a gated financials-map key
  { ...base, max_pay_rate: '' },
];
