// CCP-C5 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C5; §10) — tax is a DESIGNED
// DISABLED STATE only, until Stripe Tax registration is made and verified.
//
//   - "In: designed disabled states only, until registration. Out: live tax calculation."
//   - "HALT: any tax calculation before registration."
//
// Every read that would show tax (the C3 tenant billing status, the C6 Finance reports, the B3
// tenant Commercial overview and the tenant Sign billing account) carries this state, so a screen
// can show "Tax not enabled — pending Stripe Tax registration" (CCP-UI v1.1 brief §3.7).
//
// The state is a CONSTANT. It reads no environment variable, setting or database row, and no code
// path can turn it on: there is no flag. Enabling tax is a future release with its own
// authorization, which replaces this module (and the C5 no-tax guard spec) deliberately.
// No request to the billing provider asks it to calculate, collect or record tax
// (libs/subscription/src/tests/ccp-c5-tax-disabled.spec.ts proves this by source scan and by a
// fake provider client on every provider call).

export const TAX_NOT_ENABLED_REASON = 'STRIPE_TAX_NOT_REGISTERED' as const;

export interface TaxAvailability {
  readonly enabled: false;
  readonly reason: typeof TAX_NOT_ENABLED_REASON;
}

/** The tax state of every billing read: always disabled (a fresh object, so no caller can share or mutate it). */
export function taxAvailability(): TaxAvailability {
  return { enabled: false, reason: TAX_NOT_ENABLED_REASON };
}
