import { createHash } from 'node:crypto';

import { AramoError } from '@aramo/common';

// Aramo-Sign-Signup-Federated-Owner Amendment A1 (LOCKED) — organization details
// at signup, United States only (Lead ruling: 50 states + DC; territories and
// military addresses excluded for V1; EIN optional). The single source of the
// field rules for signup, the profile lock and self-service billing eligibility.

/** USPS codes: the 50 states + DC. Territories (PR, GU, VI, AS, MP) and military (AA, AE, AP) are excluded. */
export const US_STATE_CODES: ReadonlySet<string> = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
]);

export const BILLING_REGION_US = 'US' as const;

/** Refusal reasons (user-safe; they reveal nothing about other organizations). */
export const ORGANIZATION_COUNTRY_NOT_SUPPORTED = 'organization_country_not_supported';
export const ORGANIZATION_DETAILS_INVALID = 'organization_details_invalid';
export const ORGANIZATION_PROFILE_INCOMPLETE = 'organization_profile_incomplete';

export interface UsOrganizationDetails {
  legal_name: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  state_province: string;
  postal_code: string;
  country_code: typeof BILLING_REGION_US;
  primary_contact_email: string;
  primary_contact_name: string;
  signer_title: string;
  primary_contact_phone: string | null;
  tax_id: string | null;
  registration_number: string | null;
}

const ZIP_RE = /^\d{5}(-\d{4})?$/;
const EIN_RE = /^\d{2}-?\d{7}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t.length === 0 || t.length > max ? null : t;
}

function optional(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

function invalid(field: string, message: string, requestId: string): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, details: { reason: ORGANIZATION_DETAILS_INVALID, field } });
}

export function notSupported(requestId: string, field = 'country_code'): AramoError {
  return new AramoError(
    'VALIDATION_ERROR',
    'Aramo Sign is currently available to organizations registered in the United States.',
    400,
    { requestId, details: { reason: ORGANIZATION_COUNTRY_NOT_SUPPORTED, field } },
  );
}

/** A US phone as E.164 (+1 and 10 digits), or null for anything else. */
export function normalizeUsPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : null;
}

/**
 * Validate the signup organization details (A1 §2.2). Throws VALIDATION_ERROR
 * with reason `organization_country_not_supported` for any non-US / excluded
 * address, or `organization_details_invalid` (+ field) for anything else.
 */
export function validateUsOrganizationDetails(raw: unknown, requestId: string): UsOrganizationDetails {
  if (raw === null || typeof raw !== 'object') throw invalid('organization', 'Enter your organization details', requestId);
  const o = raw as Record<string, unknown>;
  const country = typeof o['country_code'] === 'string' ? o['country_code'].trim().toUpperCase() : 'US';
  if (country !== BILLING_REGION_US) throw notSupported(requestId);
  const state = typeof o['state_province'] === 'string' ? o['state_province'].trim().toUpperCase() : '';
  if (state === '') throw invalid('state_province', 'Choose a state', requestId);
  if (!US_STATE_CODES.has(state)) throw notSupported(requestId, 'state_province');

  const legal_name = text(o['legal_name'], 200);
  if (legal_name === null || legal_name.length < 2) throw invalid('legal_name', 'Enter the organization’s legal name', requestId);
  const address_line1 = text(o['address_line1'], 200);
  if (address_line1 === null) throw invalid('address_line1', 'Enter the street address', requestId);
  const address_line2 = optional(o['address_line2']) ? null : text(o['address_line2'], 200);
  if (!optional(o['address_line2']) && address_line2 === null) throw invalid('address_line2', 'Address line 2 is too long', requestId);
  const city = text(o['city'], 100);
  if (city === null) throw invalid('city', 'Enter the city', requestId);
  const postal_code = typeof o['postal_code'] === 'string' ? o['postal_code'].trim() : '';
  if (!ZIP_RE.test(postal_code)) throw invalid('postal_code', 'Enter a 5-digit ZIP code (or ZIP+4)', requestId);
  const email = typeof o['primary_contact_email'] === 'string' ? o['primary_contact_email'].trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) throw invalid('primary_contact_email', 'Enter a billing contact email', requestId);
  const name = text(o['primary_contact_name'], 100);
  if (name === null) throw invalid('primary_contact_name', 'Enter your full name', requestId);
  const title = text(o['signer_title'], 100);
  if (title === null) throw invalid('signer_title', 'Enter your title', requestId);

  let phone: string | null = null;
  if (!optional(o['primary_contact_phone'])) {
    phone = typeof o['primary_contact_phone'] === 'string' ? normalizeUsPhone(o['primary_contact_phone']) : null;
    if (phone === null) throw invalid('primary_contact_phone', 'Enter a US phone number', requestId);
  }
  let tax_id: string | null = null;
  if (!optional(o['tax_id'])) {
    const v = typeof o['tax_id'] === 'string' ? o['tax_id'].trim() : '';
    if (!EIN_RE.test(v)) throw invalid('tax_id', 'Enter the EIN as 12-3456789, or leave it empty', requestId);
    tax_id = v.includes('-') ? v : `${v.slice(0, 2)}-${v.slice(2)}`;
  }
  const registration_number = optional(o['registration_number']) ? null : text(o['registration_number'], 50);
  if (!optional(o['registration_number']) && registration_number === null) throw invalid('registration_number', 'Registration number is too long', requestId);

  return {
    legal_name,
    address_line1,
    address_line2,
    city,
    state_province: state,
    postal_code,
    country_code: BILLING_REGION_US,
    primary_contact_email: email,
    primary_contact_name: name,
    signer_title: title,
    primary_contact_phone: phone,
    tax_id,
    registration_number,
  };
}

// ---- India Billing Regions + Razorpay Directive v1.0 (LOCKED) §2, §4.9 --------------------------------
// Business signup and the organization profile accept a country whose billing region sells to BUSINESS
// (its region and Business switches ON). The decision lives in the billing region store, outside identity:
// the caller passes it in as `acceptsCountry` (identity takes no subscription dependency). The US keeps
// the A1 rules above unchanged; India is the only other country with address rules. Any other country
// (or India while its region is OFF) is refused exactly as before (organization_country_not_supported).

export const BILLING_REGION_IN = 'IN' as const;
/** The regions TenantBillingRegionPolicy admits (its CHECK). */
export const ORGANIZATION_BILLING_REGIONS: readonly string[] = [BILLING_REGION_US, BILLING_REGION_IN];

/** Whether a country (ISO alpha-2, upper case) is open for Business signup / billing now. */
export type OrganizationCountryAcceptance = (country: string) => boolean;

/** No country beyond the US is open (the default: exactly the A1 rule). */
export const US_ONLY: OrganizationCountryAcceptance = () => false;

/** The validated organization details of any accepted country (the US shape, any accepted country code). */
export type OrganizationDetails = Omit<UsOrganizationDetails, 'country_code'> & { country_code: string };

const PIN_RE = /^[1-9]\d{5}$/;

/** An Indian phone as E.164 (+91 and 10 digits starting 6-9), or null. */
export function normalizeInPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, '');
  const ten = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits.length === 11 && digits.startsWith('0') ? digits.slice(1) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? `+91${ten}` : null;
}

function validateIndiaOrganizationDetails(o: Record<string, unknown>, requestId: string): OrganizationDetails {
  const state = text(o['state_province'], 100);
  if (state === null) throw invalid('state_province', 'Choose a state', requestId);
  const legal_name = text(o['legal_name'], 200);
  if (legal_name === null || legal_name.length < 2) throw invalid('legal_name', 'Enter the organization’s legal name', requestId);
  const address_line1 = text(o['address_line1'], 200);
  if (address_line1 === null) throw invalid('address_line1', 'Enter the street address', requestId);
  const address_line2 = optional(o['address_line2']) ? null : text(o['address_line2'], 200);
  if (!optional(o['address_line2']) && address_line2 === null) throw invalid('address_line2', 'Address line 2 is too long', requestId);
  const city = text(o['city'], 100);
  if (city === null) throw invalid('city', 'Enter the city', requestId);
  const postal_code = typeof o['postal_code'] === 'string' ? o['postal_code'].trim() : '';
  if (!PIN_RE.test(postal_code)) throw invalid('postal_code', 'Enter a 6-digit PIN code', requestId);
  const email = typeof o['primary_contact_email'] === 'string' ? o['primary_contact_email'].trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) throw invalid('primary_contact_email', 'Enter a billing contact email', requestId);
  const name = text(o['primary_contact_name'], 100);
  if (name === null) throw invalid('primary_contact_name', 'Enter your full name', requestId);
  const title = text(o['signer_title'], 100);
  if (title === null) throw invalid('signer_title', 'Enter your title', requestId);
  let phone: string | null = null;
  if (!optional(o['primary_contact_phone'])) {
    phone = typeof o['primary_contact_phone'] === 'string' ? normalizeInPhone(o['primary_contact_phone']) : null;
    if (phone === null) throw invalid('primary_contact_phone', 'Enter an Indian mobile number', requestId);
  }
  // Registration identifiers are stored as entered (data only; never computed on).
  const tax_id = optional(o['tax_id']) ? null : text(o['tax_id'], 50);
  if (!optional(o['tax_id']) && tax_id === null) throw invalid('tax_id', 'Registration identifier is too long', requestId);
  const registration_number = optional(o['registration_number']) ? null : text(o['registration_number'], 50);
  if (!optional(o['registration_number']) && registration_number === null) throw invalid('registration_number', 'Registration number is too long', requestId);
  return {
    legal_name,
    address_line1,
    address_line2,
    city,
    state_province: state,
    postal_code,
    country_code: BILLING_REGION_IN,
    primary_contact_email: email,
    primary_contact_name: name,
    signer_title: title,
    primary_contact_phone: phone,
    tax_id,
    registration_number,
  };
}

/**
 * Validate the signup organization details for any accepted country. The US (and an omitted country)
 * is validateUsOrganizationDetails exactly; India only while `acceptsCountry('IN')`; anything else is
 * refused `organization_country_not_supported`.
 */
export function validateOrganizationDetails(raw: unknown, requestId: string, acceptsCountry: OrganizationCountryAcceptance = US_ONLY): OrganizationDetails {
  if (raw === null || typeof raw !== 'object') throw invalid('organization', 'Enter your organization details', requestId);
  const o = raw as Record<string, unknown>;
  const country = typeof o['country_code'] === 'string' ? o['country_code'].trim().toUpperCase() : BILLING_REGION_US;
  if (country === BILLING_REGION_US) return validateUsOrganizationDetails(raw, requestId);
  if (country === BILLING_REGION_IN && acceptsCountry(BILLING_REGION_IN)) return validateIndiaOrganizationDetails(o, requestId);
  throw notSupported(requestId);
}

export interface ProfileAddressFields {
  legal_name: string | null;
  address_line1: string | null;
  city: string | null;
  state_province: string | null;
  postal_code: string | null;
  country_code: string | null;
  primary_contact_email: string | null;
}

/** Why a stored profile cannot buy self-service Sign (null = eligible). */
export function usProfileIneligibility(p: ProfileAddressFields): typeof ORGANIZATION_COUNTRY_NOT_SUPPORTED | typeof ORGANIZATION_PROFILE_INCOMPLETE | null {
  if (p.country_code !== null && p.country_code.toUpperCase() !== BILLING_REGION_US) return ORGANIZATION_COUNTRY_NOT_SUPPORTED;
  if (p.state_province !== null && !US_STATE_CODES.has(p.state_province.toUpperCase())) return ORGANIZATION_COUNTRY_NOT_SUPPORTED;
  const required = [p.legal_name, p.address_line1, p.city, p.state_province, p.postal_code, p.country_code, p.primary_contact_email];
  if (required.some((v) => v === null || v.trim() === '')) return ORGANIZATION_PROFILE_INCOMPLETE;
  if (!ZIP_RE.test(p.postal_code!.trim())) return ORGANIZATION_PROFILE_INCOMPLETE;
  return null;
}

/** Why a stored Indian organization profile cannot buy self-service Sign (null = eligible). */
function inProfileIneligibility(p: ProfileAddressFields): typeof ORGANIZATION_COUNTRY_NOT_SUPPORTED | typeof ORGANIZATION_PROFILE_INCOMPLETE | null {
  if (p.country_code === null || p.country_code.trim().toUpperCase() !== BILLING_REGION_IN) return ORGANIZATION_COUNTRY_NOT_SUPPORTED;
  const required = [p.legal_name, p.address_line1, p.city, p.state_province, p.postal_code, p.country_code, p.primary_contact_email];
  if (required.some((v) => v === null || v.trim() === '')) return ORGANIZATION_PROFILE_INCOMPLETE;
  if (!PIN_RE.test((p.postal_code ?? '').trim())) return ORGANIZATION_PROFILE_INCOMPLETE;
  return null;
}

/**
 * India Billing §4.9 — why a stored profile cannot buy self-service Sign, for any accepted country (null =
 * eligible). A US or country-less profile is usProfileIneligibility exactly; India only while accepted.
 */
export function organizationProfileIneligibility(
  p: ProfileAddressFields,
  acceptsCountry: OrganizationCountryAcceptance = US_ONLY,
): typeof ORGANIZATION_COUNTRY_NOT_SUPPORTED | typeof ORGANIZATION_PROFILE_INCOMPLETE | null {
  const country = p.country_code?.trim().toUpperCase() ?? null;
  if (country === null || country === '' || country === BILLING_REGION_US) return usProfileIneligibility(p);
  if (country === BILLING_REGION_IN && acceptsCountry(BILLING_REGION_IN)) return inProfileIneligibility(p);
  return ORGANIZATION_COUNTRY_NOT_SUPPORTED;
}

/**
 * The profile rule of a tenant held to `region` (TenantBillingRegionPolicy): the profile must stay a
 * complete profile of that region (A1 §2.5). The hold itself is the acceptance: a tenant already held to
 * India keeps India's rules whatever the region switches say now (Q10: no region switch after subscribing).
 */
export function lockedProfileIneligibility(p: ProfileAddressFields, region: string): typeof ORGANIZATION_COUNTRY_NOT_SUPPORTED | typeof ORGANIZATION_PROFILE_INCOMPLETE | null {
  if (region === BILLING_REGION_IN) return inProfileIneligibility(p);
  return usProfileIneligibility(p);
}

// A1 refinement A — the attestation statement (versioned; its SHA-256 is stored
// with each attestation so the exact words attested are provable).
export const AUTHORITY_STATEMENT_VERSION = 'v1';
export function authorityStatement(legalName: string): string {
  return `I am authorized to act for ${legalName} and to accept the Aramo terms on its behalf.`;
}
export function authorityStatementSha256(): string {
  return createHash('sha256').update(authorityStatement('{legal_name}'), 'utf8').digest('hex');
}
