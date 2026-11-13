import { PRICE_TAX_MODE_LABEL, REGISTRATION_FIELDS, regionName } from '../commercial-model';

import type { BillingRegion, BillingRegionChange, PriceTaxMode, RegionEnableRefusal } from './billing-regions-api';

// India Billing Regions + Razorpay Directive v1.0 (LOCKED) §4.10, §5, §6 G-3 — the Billing regions page model.
// Pure: the edit form, the change it requests (only what differs), the G-3 reasons in plain words, and the
// registration shape check (mirrors libs/subscription region-guard.ts). Nothing here computes tax.

export const REGIONS_INTRO =
  'Where Aramo sells on the web, through which payment gateway, in which currency and from which selling entity. A region sells only when it is switched on; a change is a request that Finance approves, and switching a region on is refused until its gateway keys, selling entity and GST setting are ready.';

export const GATEWAY_LABEL: Readonly<Record<string, string>> = { STRIPE: 'Stripe', RAZORPAY: 'Razorpay' };

/** Directive §6 G-3 — what stops a region being switched on, in plain words. */
export const ENABLE_REFUSAL_TEXT: Readonly<Record<RegionEnableRefusal, string>> = {
  gateway_not_configured: 'Add the gateway keys on the server first.',
  selling_entity_inactive: 'Activate the selling entity.',
  price_tax_mode_unset: 'Set how prices handle GST.',
};

export const PRICE_TAX_MODES: readonly PriceTaxMode[] = ['UNSET', 'INCLUSIVE', 'EXCLUSIVE'];

export function taxModeLabel(m: string): string {
  return PRICE_TAX_MODE_LABEL[m] ?? m;
}

export { regionName, REGISTRATION_FIELDS };

export interface RegionForm {
  enabled: boolean;
  personal_web_enabled: boolean;
  business_web_enabled: boolean;
  price_tax_mode: PriceTaxMode;
  display_name: string;
  legal_name: string;
  entity_active: boolean;
  registration: Record<string, string>;
}

export function formOf(r: BillingRegion): RegionForm {
  return {
    enabled: r.enabled,
    personal_web_enabled: r.personal_web_enabled,
    business_web_enabled: r.business_web_enabled,
    price_tax_mode: r.price_tax_mode,
    display_name: r.selling_entity.display_name,
    legal_name: r.selling_entity.legal_name,
    entity_active: r.selling_entity.active,
    registration: Object.fromEntries(REGISTRATION_FIELDS.map((f) => [f.key, r.registration[f.key] ?? ''])),
  };
}

const trimmedRegistration = (reg: Record<string, string>): Record<string, string> =>
  Object.fromEntries(REGISTRATION_FIELDS.map((f) => [f.key, (reg[f.key] ?? '').trim()]).filter(([, v]) => v !== ''));

const sameRecord = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};

/** The BILLING_REGION_CHANGE the form asks for: only the fields that differ (null: nothing changes). */
export function changeOf(r: BillingRegion, f: RegionForm): BillingRegionChange | null {
  const c: BillingRegionChange = { country: r.country };
  if (f.enabled !== r.enabled) c.enabled = f.enabled;
  if (f.personal_web_enabled !== r.personal_web_enabled) c.personal_web_enabled = f.personal_web_enabled;
  if (f.business_web_enabled !== r.business_web_enabled) c.business_web_enabled = f.business_web_enabled;
  if (f.price_tax_mode !== r.price_tax_mode) c.price_tax_mode = f.price_tax_mode;
  const e: NonNullable<BillingRegionChange['selling_entity']> = {};
  if (f.display_name.trim() !== r.selling_entity.display_name) e.display_name = f.display_name.trim();
  if (f.legal_name.trim() !== r.selling_entity.legal_name) e.legal_name = f.legal_name.trim();
  if (f.entity_active !== r.selling_entity.active) e.active = f.entity_active;
  const reg = trimmedRegistration(f.registration);
  // The registration document is replaced as a whole (directive §5); only sent when it changes.
  if (!sameRecord(reg, trimmedRegistration(r.registration))) e.registration = reg;
  if (Object.keys(e).length > 0) c.selling_entity = e;
  return Object.keys(c).length > 1 ? c : null;
}

const GSTIN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** The form's input errors (empty = it may be requested). Shape only. */
export function formErrors(f: RegionForm): string[] {
  const out: string[] = [];
  if (f.display_name.trim() === '') out.push('The selling entity name is required.');
  if (f.legal_name.trim() === '') out.push('The selling entity legal name is required.');
  const gstin = (f.registration['gstin'] ?? '').trim();
  const pan = (f.registration['pan'] ?? '').trim();
  if (gstin !== '' && !GSTIN.test(gstin)) out.push('GSTIN must be the 15-character GST number (for example 27AAPFU0939F1ZV).');
  if (pan !== '' && !PAN.test(pan)) out.push('PAN must be the 10-character PAN (for example AAPFU0939F).');
  return out;
}

/**
 * G-3 as the form would leave the region (shown, never enforced here: the apply refuses it, so a request
 * may be raised now and applied once the keys are set). Empty when the region would be off.
 */
export function enableBlockers(r: BillingRegion, f: RegionForm): string[] {
  if (!f.enabled) return [];
  const out: string[] = [];
  if (!r.gateway_configured) out.push(ENABLE_REFUSAL_TEXT.gateway_not_configured);
  if (!f.entity_active) out.push(ENABLE_REFUSAL_TEXT.selling_entity_inactive);
  if (r.gateway === 'RAZORPAY' && f.price_tax_mode === 'UNSET') out.push(ENABLE_REFUSAL_TEXT.price_tax_mode_unset);
  return out;
}

export const onOff = (v: boolean): string => (v ? 'On' : 'Off');

/** The region's label in the list ("India (IN)"). */
export function regionLabel(r: Pick<BillingRegion, 'country'>): string {
  return regionName(r.country);
}
