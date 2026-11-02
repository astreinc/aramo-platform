import { type ProductKey, productOfMeteredKey } from '../product-registry.js';

// Sign usage / metered billing (Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §3 item 2,
// §5 D-2; Amendment A1 §A1.1) — the code mirror of the governed MeteredUnit registry (migration
// 20261101300000_sign_usage_metering). A test pins the two together. Widening is an additive
// migration plus a code change here; a unit key outside this list is refused (fail closed).
//
// A unit is a per-unit billable event (an SMS sent, an ID check attempted, a stamp bought). It is
// NOT an allowance: it has no included quantity and never touches AllowanceUsage (MP-A2 N-1, A3 D3).
// What a unit costs is approved catalog content on a plan version (content.unit_prices, Amendment
// A3 D1, covered by the PLAN_VERSION_PUBLISH fingerprint), never a constant here.

export const METERED_UNIT_KEYS = [
  'sign.sms_message',
  'sign.whatsapp_message',
  'sign.sms_otp',
  'sign.id_verification',
  'sign.kba',
  'sign.qes_signature',
  'sign.india_estamp',
] as const;
export type MeteredUnitKey = (typeof METERED_UNIT_KEYS)[number];

export function isMeteredUnitKey(value: unknown): value is MeteredUnitKey {
  return typeof value === 'string' && (METERED_UNIT_KEYS as readonly string[]).includes(value);
}

/** The product a metered unit is sold for (sign.sms_message → sign). */
export function productOfMeteredUnit(unit: MeteredUnitKey): ProductKey {
  return productOfMeteredKey(unit);
}

/** The env flag that turns metered billing on (unset = off: every metered call is refused). */
export const SIGN_USAGE_BILLING_FLAG = 'SIGN_USAGE_BILLING_ENABLED';

/** Metered billing is on only with SIGN_USAGE_BILLING_ENABLED=1 (unset or anything else = off). */
export function usageBillingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SIGN_USAGE_BILLING_FLAG] === '1';
}

/**
 * The provider (Stripe Billing) meter event name a unit's usage is reported under:
 * sign.sms_message → aramo_sign_sms_message. Deterministic, so the meters and metered prices set up
 * at the provider (open decision D4) need no Aramo-side configuration.
 */
export function meterEventNameOf(unit: MeteredUnitKey): string {
  return `aramo_${unit.replace(/\./g, '_')}`;
}
