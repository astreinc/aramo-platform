import { AramoError } from '@aramo/common';

// Settings Rebuild Directive 3 — tenant profile shapes + validation.
//
// The Tenant.name (the workspace identifier) is NOT editable here — it is the
// AUTHZ-2 provisioning key. This surface owns the enterprise profile fields
// (all nullable, all editable by a tenant admin).

// The editable profile fields, in render order. The single source of truth the
// view, the PATCH whitelist, and validation all derive from.
export const PROFILE_FIELDS = [
  'legal_name',
  'display_name',
  'address_line1',
  'address_line2',
  'city',
  'state_province',
  'postal_code',
  'country_code',
  'tax_id',
  'registration_number',
  'primary_contact_name',
  'primary_contact_email',
  'primary_contact_phone',
  'logo_url',
] as const;

export type ProfileField = (typeof PROFILE_FIELDS)[number];

export interface TenantProfileView {
  readonly id: string;
  /** The canonical workspace name (read-only here). */
  readonly name: string;
  readonly legal_name: string | null;
  readonly display_name: string | null;
  readonly address_line1: string | null;
  readonly address_line2: string | null;
  readonly city: string | null;
  readonly state_province: string | null;
  readonly postal_code: string | null;
  readonly country_code: string | null;
  readonly tax_id: string | null;
  readonly registration_number: string | null;
  readonly primary_contact_name: string | null;
  readonly primary_contact_email: string | null;
  readonly primary_contact_phone: string | null;
  readonly logo_url: string | null;
  readonly updated_at: string;
}

// A PATCH value: a string sets it, null clears it, undefined leaves unchanged.
export type ProfilePatch = Partial<Record<ProfileField, string | null>>;

// Per-field max lengths (defensive bounds; the DB columns are unbounded TEXT).
const MAX_LEN: Record<ProfileField, number> = {
  legal_name: 200,
  display_name: 200,
  address_line1: 300,
  address_line2: 300,
  city: 120,
  state_province: 120,
  postal_code: 32,
  country_code: 2,
  tax_id: 64,
  registration_number: 64,
  primary_contact_name: 200,
  primary_contact_email: 320,
  primary_contact_phone: 40,
  logo_url: 2048,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COUNTRY_RE = /^[A-Za-z]{2}$/;

// Builds a validated patch from a raw body. ONLY whitelisted fields are read
// (an unknown field is rejected, not silently ignored — defense-in-depth).
// Every failure is a 400 VALIDATION_ERROR (never a 500). Returns the cleaned
// patch (trimmed strings; '' coerced to null = clear).
export function validateProfilePatch(
  body: Record<string, unknown>,
  requestId: string,
): ProfilePatch {
  const allowed = new Set<string>(PROFILE_FIELDS);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw bad(`unknown profile field '${key}'`, requestId, {
        reason: 'unknown_field',
        field: key,
        allowed: [...PROFILE_FIELDS],
      });
    }
  }
  const patch: ProfilePatch = {};
  for (const field of PROFILE_FIELDS) {
    if (!(field in body)) continue;
    const raw = body[field];
    if (raw === null) {
      patch[field] = null;
      continue;
    }
    if (typeof raw !== 'string') {
      throw bad(`${field} must be a string or null`, requestId, {
        reason: 'invalid_type',
        field,
      });
    }
    const value = raw.trim();
    if (value.length === 0) {
      patch[field] = null; // empty → clear
      continue;
    }
    if (value.length > MAX_LEN[field]) {
      throw bad(`${field} exceeds ${MAX_LEN[field]} characters`, requestId, {
        reason: 'too_long',
        field,
        max: MAX_LEN[field],
      });
    }
    if (field === 'primary_contact_email' && !EMAIL_RE.test(value)) {
      throw bad('primary_contact_email is not a valid email', requestId, {
        reason: 'invalid_email',
        field,
      });
    }
    if (field === 'country_code' && !COUNTRY_RE.test(value)) {
      throw bad('country_code must be a 2-letter ISO code', requestId, {
        reason: 'invalid_country_code',
        field,
      });
    }
    if (field === 'logo_url' && !isHttpUrl(value)) {
      throw bad('logo_url must be an http(s) URL', requestId, {
        reason: 'invalid_url',
        field,
      });
    }
    patch[field] = field === 'country_code' ? value.toUpperCase() : value;
  }
  return patch;
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function bad(
  message: string,
  requestId: string,
  details: Record<string, unknown>,
): AramoError {
  return new AramoError('VALIDATION_ERROR', message, 400, { requestId, details });
}
