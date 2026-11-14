// Stripe API Upgrade directive v1.0 §4, ruling Q2 (PO 2026-11-14) — the ONE explicit server switch for
// live Stripe billing. A live-mode key alone never activates live billing: with the switch off, the
// billing commands, the billing status reads and the usage reports are held exactly as before (the key
// is live, nothing is sent or read). The switch is flipped only in the separately authorized go-live
// window (directive §6). A test-mode key is unaffected by the switch.

/** The env flag that releases live Stripe billing (unset = off). */
export const SIGN_STRIPE_LIVE_BILLING_FLAG = 'SIGN_STRIPE_LIVE_BILLING_ENABLED';

/** Live Stripe billing is released only with SIGN_STRIPE_LIVE_BILLING_ENABLED=1 (unset or anything else = off). */
export function liveStripeBillingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SIGN_STRIPE_LIVE_BILLING_FLAG] === '1';
}

/** A provider in this key mode is held: a live-mode key without the switch. */
export function liveStripeBillingHeld(mode: 'test' | 'live', env: NodeJS.ProcessEnv = process.env): boolean {
  return mode === 'live' && !liveStripeBillingEnabled(env);
}
