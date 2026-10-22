// Aramo-Sign-Signup-Federated-Owner Amendment A1 (LOCKED) §2.2 — organization
// details at signup, United States only. Client-side rules mirror the server
// (libs/identity us-organization.ts); the server stays the authority.

/** USPS codes and names: the 50 states + DC. No territories, no military codes (A1 §1). */
export const US_STATES: ReadonlyArray<readonly [code: string, name: string]> = [
  ['AL', 'Alabama'],
  ['AK', 'Alaska'],
  ['AZ', 'Arizona'],
  ['AR', 'Arkansas'],
  ['CA', 'California'],
  ['CO', 'Colorado'],
  ['CT', 'Connecticut'],
  ['DE', 'Delaware'],
  ['DC', 'District of Columbia'],
  ['FL', 'Florida'],
  ['GA', 'Georgia'],
  ['HI', 'Hawaii'],
  ['ID', 'Idaho'],
  ['IL', 'Illinois'],
  ['IN', 'Indiana'],
  ['IA', 'Iowa'],
  ['KS', 'Kansas'],
  ['KY', 'Kentucky'],
  ['LA', 'Louisiana'],
  ['ME', 'Maine'],
  ['MD', 'Maryland'],
  ['MA', 'Massachusetts'],
  ['MI', 'Michigan'],
  ['MN', 'Minnesota'],
  ['MS', 'Mississippi'],
  ['MO', 'Missouri'],
  ['MT', 'Montana'],
  ['NE', 'Nebraska'],
  ['NV', 'Nevada'],
  ['NH', 'New Hampshire'],
  ['NJ', 'New Jersey'],
  ['NM', 'New Mexico'],
  ['NY', 'New York'],
  ['NC', 'North Carolina'],
  ['ND', 'North Dakota'],
  ['OH', 'Ohio'],
  ['OK', 'Oklahoma'],
  ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'],
  ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'],
  ['SD', 'South Dakota'],
  ['TN', 'Tennessee'],
  ['TX', 'Texas'],
  ['UT', 'Utah'],
  ['VT', 'Vermont'],
  ['VA', 'Virginia'],
  ['WA', 'Washington'],
  ['WV', 'West Virginia'],
  ['WI', 'Wisconsin'],
  ['WY', 'Wyoming'],
];

const STATE_CODES = new Set(US_STATES.map(([c]) => c));

export interface OrgDetailsValues {
  legal_name: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state_province: string;
  postal_code: string;
  primary_contact_email: string;
  primary_contact_name: string;
  signer_title: string;
  primary_contact_phone: string;
  tax_id: string;
  registration_number: string;
}

/** The `organization` object POSTed to /v1/signup/sign/complete. */
export interface OrganizationPayload {
  legal_name: string;
  address_line1: string;
  address_line2?: string;
  city: string;
  state_province: string;
  postal_code: string;
  country_code: 'US';
  primary_contact_email: string;
  primary_contact_name: string;
  signer_title: string;
  primary_contact_phone?: string;
  tax_id?: string;
  registration_number?: string;
  authority_attested: true;
}

export type FieldErrors = Partial<Record<keyof OrgDetailsValues | 'authority_attested' | 'organization_name', string>>;

const ZIP_RE = /^\d{5}(-\d{4})?$/;
const EIN_RE = /^\d{2}-?\d{7}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const clean = (v: string) => v.replace(/\s+/g, ' ').trim();

/** A US phone as E.164 (+1 and 10 digits), or null. */
export function normalizeUsPhone(raw: string): string | null {
  const digits = raw.replace(/[^\d]/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : null;
}

export function validateOrgDetails(v: OrgDetailsValues, attested: boolean): FieldErrors {
  const e: FieldErrors = {};
  const legal = clean(v.legal_name);
  if (legal.length < 2 || legal.length > 200) e.legal_name = 'Enter the legal name (2–200 characters).';
  const line1 = clean(v.address_line1);
  if (line1.length === 0 || line1.length > 200) e.address_line1 = 'Enter the street address.';
  if (clean(v.address_line2).length > 200) e.address_line2 = 'Keep address line 2 under 200 characters.';
  const city = clean(v.city);
  if (city.length === 0 || city.length > 100) e.city = 'Enter the city.';
  if (!STATE_CODES.has(v.state_province)) e.state_province = 'Choose a state.';
  if (!ZIP_RE.test(v.postal_code.trim())) e.postal_code = 'Use a 5-digit ZIP code, like 22181.';
  if (!EMAIL_RE.test(v.primary_contact_email.trim())) e.primary_contact_email = 'Enter a valid email address.';
  const name = clean(v.primary_contact_name);
  if (name.length === 0 || name.length > 100) e.primary_contact_name = 'Enter your full name.';
  const title = clean(v.signer_title);
  if (title.length === 0 || title.length > 100) e.signer_title = 'Enter your title.';
  if (v.primary_contact_phone.trim() !== '' && normalizeUsPhone(v.primary_contact_phone) === null) e.primary_contact_phone = 'Enter a 10-digit US phone number.';
  if (v.tax_id.trim() !== '' && !EIN_RE.test(v.tax_id.trim())) e.tax_id = 'Enter the EIN as 12-3456789.';
  if (clean(v.registration_number).length > 50) e.registration_number = 'Keep the registration number under 50 characters.';
  if (!attested) e.authority_attested = 'Confirm that you are authorized to act for this organization.';
  return e;
}

export function toOrganizationPayload(v: OrgDetailsValues): OrganizationPayload {
  const opt = (s: string) => (clean(s) !== '' ? clean(s) : undefined);
  const phone = v.primary_contact_phone.trim() !== '' ? normalizeUsPhone(v.primary_contact_phone) ?? undefined : undefined;
  const line2 = opt(v.address_line2);
  const tax = opt(v.tax_id);
  const reg = opt(v.registration_number);
  return {
    legal_name: clean(v.legal_name),
    address_line1: clean(v.address_line1),
    ...(line2 !== undefined ? { address_line2: line2 } : {}),
    city: clean(v.city),
    state_province: v.state_province,
    postal_code: v.postal_code.trim(),
    country_code: 'US',
    primary_contact_email: v.primary_contact_email.trim(),
    primary_contact_name: clean(v.primary_contact_name),
    signer_title: clean(v.signer_title),
    ...(phone !== undefined ? { primary_contact_phone: phone } : {}),
    ...(tax !== undefined ? { tax_id: tax } : {}),
    ...(reg !== undefined ? { registration_number: reg } : {}),
    authority_attested: true,
  };
}

/** Which activation step (handoff §4.4) owns each organization-details field. */
export type BusinessStep = 'organization' | 'address' | 'billing' | 'you';

export const FIELD_STEP: Record<keyof FieldErrors, BusinessStep> = {
  organization_name: 'organization',
  legal_name: 'organization',
  address_line1: 'address',
  address_line2: 'address',
  city: 'address',
  state_province: 'address',
  postal_code: 'address',
  primary_contact_email: 'billing',
  primary_contact_phone: 'billing',
  tax_id: 'billing',
  registration_number: 'billing',
  primary_contact_name: 'you',
  signer_title: 'you',
  authority_attested: 'you',
};
