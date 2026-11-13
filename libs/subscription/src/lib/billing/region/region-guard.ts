// Aramo India Billing Regions + Razorpay Directive v1.0 (LOCKED) §5, §6 — the pure region rules: the G-3
// enable guard and the shape of a BILLING_REGION_CHANGE (its registration identifiers included). No I/O.

import {
  PRICE_TAX_MODES,
  SELLING_ENTITY_REGISTRATION_KEYS,
  type BillingRegionView,
  type RegionEnableRefusal,
} from './billing-region.view.js';

/**
 * Directive §6 G-3 — whether a region may be switched ON (null = it may). Refused unless its gateway is
 * configured and its selling entity is active, and, for a Razorpay region, its price tax mode is set
 * (that needs the C5 GST amendment). A Stripe region keeps the existing CCP-C5 state.
 */
export function regionEnableRefusal(r: BillingRegionView, gatewayConfigured: boolean): null | RegionEnableRefusal {
  if (!gatewayConfigured) return 'gateway_not_configured';
  if (!r.selling_entity.active) return 'selling_entity_inactive';
  if (r.gateway === 'RAZORPAY' && r.price_tax_mode === 'UNSET') return 'price_tax_mode_unset';
  return null;
}

/** India GSTIN shape: 2-digit state, 10-character PAN, entity number, Z, check character. */
export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
/** India PAN shape. */
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

const REGISTRATION_VALUE_MAX = 200;
const NOTE_MAX = 1000;
const NAME_MAX = 200;
const ISO2 = /^[A-Z]{2}$/;

/** Shape errors of a selling entity's registration document (empty = valid). Shape only, never a lookup. */
export function registrationErrors(v: unknown): string[] {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return ['registration must be an object'];
  const errors: string[] = [];
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (!(SELLING_ENTITY_REGISTRATION_KEYS as readonly string[]).includes(k)) {
      errors.push(`registration.${k} is not allowed (allowed: ${SELLING_ENTITY_REGISTRATION_KEYS.join(', ')})`);
      continue;
    }
    if (typeof val !== 'string' || val.trim() === '' || val !== val.trim()) {
      errors.push(`registration.${k} must be a non-empty trimmed string`);
      continue;
    }
    if (val.length > (k === 'note' ? NOTE_MAX : REGISTRATION_VALUE_MAX)) errors.push(`registration.${k} is too long`);
    if (k === 'gstin' && !GSTIN_PATTERN.test(val)) errors.push('registration.gstin must be a 15-character GSTIN');
    if (k === 'pan' && !PAN_PATTERN.test(val)) errors.push('registration.pan must be a 10-character PAN');
  }
  return errors;
}

const CHANGE_KEYS = ['country', 'enabled', 'personal_web_enabled', 'business_web_enabled', 'price_tax_mode', 'selling_entity'] as const;
const ENTITY_KEYS = ['display_name', 'legal_name', 'registration', 'active'] as const;

/** Shape errors of a BILLING_REGION_CHANGE payload (empty = valid). Validated at create and again at apply. */
export function billingRegionChangeErrors(p: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const k of Object.keys(p)) if (!(CHANGE_KEYS as readonly string[]).includes(k)) errors.push(`${k} is not a field of this action`);
  if (typeof p['country'] !== 'string' || !ISO2.test(p['country'])) errors.push('country must be an ISO 3166-1 alpha-2 code');
  for (const k of ['enabled', 'personal_web_enabled', 'business_web_enabled'] as const) {
    if (p[k] !== undefined && typeof p[k] !== 'boolean') errors.push(`${k} must be a boolean`);
  }
  if (p['price_tax_mode'] !== undefined && !(PRICE_TAX_MODES as readonly unknown[]).includes(p['price_tax_mode'])) {
    errors.push(`price_tax_mode must be one of ${PRICE_TAX_MODES.join(', ')}`);
  }
  let changes = CHANGE_KEYS.filter((k) => k !== 'country' && k !== 'selling_entity' && p[k] !== undefined).length;
  const e = p['selling_entity'];
  if (e !== undefined) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) {
      errors.push('selling_entity must be an object');
    } else {
      const o = e as Record<string, unknown>;
      for (const k of Object.keys(o)) if (!(ENTITY_KEYS as readonly string[]).includes(k)) errors.push(`selling_entity.${k} is not allowed`);
      for (const k of ['display_name', 'legal_name'] as const) {
        const v = o[k];
        if (v !== undefined && (typeof v !== 'string' || v.trim() === '' || v !== v.trim() || v.length > NAME_MAX)) errors.push(`selling_entity.${k} must be a non-empty trimmed string of at most ${NAME_MAX} characters`);
      }
      if (o['active'] !== undefined && typeof o['active'] !== 'boolean') errors.push('selling_entity.active must be a boolean');
      if (o['registration'] !== undefined) errors.push(...registrationErrors(o['registration']).map((m) => `selling_entity.${m}`));
      changes += ENTITY_KEYS.filter((k) => o[k] !== undefined).length;
    }
  }
  if (changes === 0) errors.push('the change names no field to change');
  return errors;
}
