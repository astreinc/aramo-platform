// M-A12 W1-E — the user's own Sign profile and settings (contract §3):
//   GET/PUT /v1/sign/me/profile   { display_name (1..120), title?, company?, address…,
//                                   country? (ISO-2), phone? (E.164) } — optional fields
//                                   nullable, max 200
//   GET/PUT /v1/sign/me/settings  { date_format, default_field_size }
// The profile pre-fills the profile field types (W1-C.4) for the signed-in user only, and
// the settings set the date format of SIGN_DATE and the starting size of placed fields.
// Routes are not in the generated types yet: typed by api/m-a12-contract-types.ts.
import { useQuery } from '@tanstack/react-query';

import { isApiError } from '../../api/errors';
import type {
  DateFormat,
  FieldSize,
  SignProfile,
  SignSettings,
} from '../../api/m-a12-contract-types';
import type { WorkspaceClient } from '../../api/workspaceClient';
import { useServices } from '../../app/ServicesContext';

export const profileKeys = {
  profile: ['sign', 'me', 'profile'] as const,
  settings: ['sign', 'me', 'settings'] as const,
};

export const DISPLAY_NAME_MAX = 120;
export const PROFILE_FIELD_MAX = 200;

export const DEFAULT_SETTINGS: SignSettings = { date_format: 'MM/DD/YYYY', default_field_size: 'M' };

export const DATE_FORMATS: readonly DateFormat[] = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'];
export const FIELD_SIZES: readonly { key: FieldSize; label: string; hint: string }[] = [
  { key: 'S', label: 'Small', hint: 'Fits tight forms and tables' },
  { key: 'M', label: 'Medium', hint: 'Recommended for most documents' },
  { key: 'L', label: 'Large', hint: 'Easier to tap on a phone' },
];

export type ProfileKey = Exclude<keyof SignProfile, 'display_name'>;

/** The editable optional rows, in the prototype's order. */
export const PROFILE_ROWS: readonly { key: ProfileKey; label: string; placeholder: string }[] = [
  { key: 'title', label: 'Title', placeholder: 'Job title' },
  { key: 'company', label: 'Company', placeholder: 'Company name' },
  { key: 'phone', label: 'Phone', placeholder: '+15551234567' },
  { key: 'address_line1', label: 'Address', placeholder: 'Street address' },
  { key: 'address_line2', label: 'Address line 2', placeholder: 'Apartment, suite (optional)' },
  { key: 'city', label: 'City', placeholder: 'City' },
  { key: 'region', label: 'State / region', placeholder: 'State' },
  { key: 'postal_code', label: 'Postal code', placeholder: 'ZIP or postal code' },
  { key: 'country', label: 'Country', placeholder: 'Two-letter code, e.g. US' },
];

export type ProfileDraft = { display_name: string } & { [K in ProfileKey]: string };

export function draftFromProfile(p: SignProfile | null | undefined, fallbackName = ''): ProfileDraft {
  const v = (x: string | null | undefined) => x ?? '';
  return {
    display_name: p?.display_name ?? fallbackName,
    title: v(p?.title),
    company: v(p?.company),
    address_line1: v(p?.address_line1),
    address_line2: v(p?.address_line2),
    city: v(p?.city),
    region: v(p?.region),
    postal_code: v(p?.postal_code),
    country: v(p?.country),
    phone: v(p?.phone),
  };
}

export type ProfileErrors = Partial<Record<keyof ProfileDraft, string>>;

const E164 = /^\+[1-9]\d{6,14}$/;
const ISO2 = /^[A-Za-z]{2}$/;

/** Client checks that mirror the server's (the server checks again). */
export function validateProfile(d: ProfileDraft): ProfileErrors {
  const e: ProfileErrors = {};
  const name = d.display_name.trim();
  if (name.length === 0) e.display_name = 'Enter your name.';
  else if (name.length > DISPLAY_NAME_MAX) e.display_name = `Use at most ${DISPLAY_NAME_MAX} characters.`;
  for (const row of PROFILE_ROWS) {
    if (d[row.key].trim().length > PROFILE_FIELD_MAX)
      e[row.key] = `Use at most ${PROFILE_FIELD_MAX} characters.`;
  }
  const phone = d.phone.trim();
  if (phone && !E164.test(phone)) e.phone = 'Use the international format, e.g. +15551234567.';
  const country = d.country.trim();
  if (country && !ISO2.test(country)) e.country = 'Use the two-letter country code, e.g. US.';
  return e;
}

/** The PUT body: trimmed; an empty optional field is sent as null (cleared). */
export function profileBody(d: ProfileDraft): SignProfile {
  const opt = (x: string) => (x.trim() ? x.trim() : null);
  return {
    display_name: d.display_name.trim(),
    title: opt(d.title),
    company: opt(d.company),
    address_line1: opt(d.address_line1),
    address_line2: opt(d.address_line2),
    city: opt(d.city),
    region: opt(d.region),
    postal_code: opt(d.postal_code),
    country: d.country.trim() ? d.country.trim().toUpperCase() : null,
    phone: opt(d.phone),
  };
}

/**
 * W1-C.4 — what the profile pre-fills for a field type, or null when it holds nothing.
 * FIRST_NAME / LAST_NAME split the display name at its first space.
 */
export function profileValue(
  fieldType: string,
  profile: SignProfile | null | undefined,
  email: string | null | undefined,
): string | null {
  const name = (profile?.display_name ?? '').trim();
  const [first, ...rest] = name.split(/\s+/).filter(Boolean);
  const v = (x: string | null | undefined) => (x && x.trim() ? x.trim() : null);
  switch (fieldType) {
    case 'SIGNER_NAME':
      return v(name);
    case 'FIRST_NAME':
      return v(first);
    case 'LAST_NAME':
      return v(rest.join(' '));
    case 'EMAIL':
      return v(email);
    case 'COMPANY':
      return v(profile?.company);
    case 'TITLE':
      return v(profile?.title);
    default:
      return null;
  }
}

/** A date in the user's format (W1-E.2). */
export function formatDate(d: Date, format: DateFormat): string {
  const y = String(d.getFullYear());
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  if (format === 'DD/MM/YYYY') return `${day}/${m}/${y}`;
  if (format === 'YYYY-MM-DD') return `${y}-${m}-${day}`;
  return `${m}/${day}/${y}`;
}

export function asSettings(v: unknown): SignSettings {
  const o = (v ?? {}) as Record<string, unknown>;
  const df = o['date_format'];
  const fs = o['default_field_size'];
  return {
    date_format: (DATE_FORMATS as readonly string[]).includes(df as string)
      ? (df as DateFormat)
      : DEFAULT_SETTINGS.date_format,
    default_field_size: fs === 'S' || fs === 'M' || fs === 'L' ? fs : DEFAULT_SETTINGS.default_field_size,
  };
}

// ── API ────────────────────────────────────────────────────────────────────────

/** The profile; null when the server has none for this user yet (404). */
export async function loadProfile(workspace: WorkspaceClient): Promise<SignProfile | null> {
  try {
    const r = await workspace.request<SignProfile>({ method: 'GET', path: '/v1/sign/me/profile' });
    return r.data;
  } catch (e) {
    if (isApiError(e) && e.status === 404) return null;
    throw e;
  }
}

export async function saveProfile(workspace: WorkspaceClient, body: SignProfile): Promise<SignProfile> {
  const r = await workspace.request<SignProfile>({ method: 'PUT', path: '/v1/sign/me/profile', body });
  return r.data ?? body;
}

/** The settings; the defaults when the route is not there yet (404). */
export async function loadSettings(workspace: WorkspaceClient): Promise<SignSettings> {
  try {
    const r = await workspace.request<SignSettings>({ method: 'GET', path: '/v1/sign/me/settings' });
    return asSettings(r.data);
  } catch (e) {
    if (isApiError(e) && e.status === 404) return DEFAULT_SETTINGS;
    throw e;
  }
}

export async function saveSettings(workspace: WorkspaceClient, body: SignSettings): Promise<SignSettings> {
  const r = await workspace.request<SignSettings>({ method: 'PUT', path: '/v1/sign/me/settings', body });
  return asSettings(r.data ?? body);
}

export function useSignProfile(enabled = true) {
  const { workspace } = useServices();
  return useQuery({ queryKey: profileKeys.profile, queryFn: () => loadProfile(workspace), enabled });
}

export function useSignSettings(enabled = true) {
  const { workspace } = useServices();
  return useQuery({
    queryKey: profileKeys.settings,
    queryFn: () => loadSettings(workspace),
    enabled,
    meta: { persist: true },
  });
}
