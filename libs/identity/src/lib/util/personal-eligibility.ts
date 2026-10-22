import { parsePhoneNumberFromString } from 'libphonenumber-js';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1 (LOCKED) §6.6 / §10 — the
// Personal (Free) eligibility and activation configuration. Operational controls,
// not proof of residence (and not sanctions compliance).

export const DEFAULT_PERSONAL_ALLOWED_COUNTRIES: readonly string[] = ['US', 'IN'];

/**
 * SIGN_PERSONAL_ALLOWED_COUNTRIES (default `US,IN`) as upper-case ISO 3166-1
 * alpha-2 codes. Malformed entries are dropped; an empty result falls back to the
 * default (never "everyone").
 */
export function PERSONAL_ALLOWED_COUNTRIES(env: NodeJS.ProcessEnv = process.env): readonly string[] {
  const raw = env['SIGN_PERSONAL_ALLOWED_COUNTRIES'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_PERSONAL_ALLOWED_COUNTRIES;
  const codes = raw
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c));
  return codes.length === 0 ? DEFAULT_PERSONAL_ALLOWED_COUNTRIES : [...new Set(codes)];
}

/**
 * The ISO alpha-2 region of an E.164 number (libphonenumber metadata), or null
 * when the number is not valid E.164. NANP numbers resolve to their own region —
 * a Canadian or Caribbean +1 number is never 'US'.
 */
export function phoneRegion(e164: string): string | null {
  if (typeof e164 !== 'string' || !/^\+[1-9]\d{6,14}$/.test(e164.trim())) return null;
  const parsed = parsePhoneNumberFromString(e164.trim());
  if (parsed === undefined || !parsed.isValid()) return null;
  return parsed.country ?? null;
}

/** Normalize a phone number to E.164 (null when it is not a valid number). */
export function normalizeE164(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const parsed = parsePhoneNumberFromString(raw.trim());
  if (parsed === undefined || !parsed.isValid()) return null;
  return parsed.number;
}

// §10 activation modes. Anything but 'invite' / 'open' is 'off' (the shipped default).
export const PERSONAL_SIGNUP_MODES = ['off', 'invite', 'open'] as const;
export type PersonalSignupMode = (typeof PERSONAL_SIGNUP_MODES)[number];

export function personalSignupMode(env: NodeJS.ProcessEnv = process.env): PersonalSignupMode {
  const v = env['SIGN_PERSONAL_SIGNUP_MODE']?.trim().toLowerCase();
  return v === 'invite' || v === 'open' ? v : 'off';
}

export const DEFAULT_PERSONAL_PILOT_CAP = 10;

/** SIGN_PERSONAL_PILOT_CAP (default 10): the most active pilot tenants in `invite` mode. */
export function personalPilotCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['SIGN_PERSONAL_PILOT_CAP'];
  if (raw === undefined || raw.trim() === '') return DEFAULT_PERSONAL_PILOT_CAP;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_PERSONAL_PILOT_CAP;
}
