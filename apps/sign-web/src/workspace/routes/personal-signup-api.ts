// Aramo Sign Personal (Free) — the session-less client for the public Personal
// signup surface (Aramo-Sign-Personal-Free-Launch-Directive-v1_1 §3). Every route
// lives under /v1/signup/sign/personal/* on platform-admin and answers 404 while
// SIGN_PERSONAL_SIGNUP_MODE is `off`. Nothing here decides eligibility, risk or
// access: the backend does, and this module only carries its answers.

export const PERSONAL_API = '/v1/signup/sign/personal';

export type Country = 'US' | 'IN';

/** The only two countries a Personal account is offered in (§6.6). */
export const COUNTRIES: readonly { code: Country; name: string; dial: string }[] = [
  { code: 'US', name: 'United States', dial: '+1' },
  { code: 'IN', name: 'India', dial: '+91' },
];

export type NextStep = 'phone' | 'terms' | 'review';

export interface TermsDocument {
  key: string;
  version: string;
  url: string;
  sha256: string;
}

/** What the new account must wait for before sending (§6.3): review clearance or phone assurance. */
export type Held = 'review' | 'phone_verification_required' | null;

export interface CompleteResponse {
  status: string;
  held?: Held;
  sign_in?: { google?: string };
}

export interface PersonalSignupError {
  status: number;
  code?: string;
  reason?: string;
  message: string;
  details: Record<string, unknown>;
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

export async function personalPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${PERSONAL_API}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as ErrorBody & T;
  if (!res.ok) {
    const details = json.error?.details ?? {};
    const err: PersonalSignupError = {
      status: res.status,
      message: json.error?.message ?? 'Something went wrong. Try again.',
      details,
    };
    if (json.error?.code !== undefined) err.code = json.error.code;
    if (typeof details['reason'] === 'string') err.reason = details['reason'];
    throw err;
  }
  return json;
}

/** GET …/terms — `null` documents while any of the three is not APPROVED; 404 while the mode is off. */
export async function fetchPersonalTerms(): Promise<{ off: true } | { off: false; documents: TermsDocument[] | null }> {
  const res = await fetch(`${PERSONAL_API}/terms`);
  if (res.status === 404) return { off: true };
  if (!res.ok) throw new Error(`terms ${res.status}`);
  const j = (await res.json().catch(() => ({}))) as { documents?: TermsDocument[] | null };
  return { off: false, documents: Array.isArray(j.documents) && j.documents.length > 0 ? j.documents : null };
}

/** The national number typed by the person + the chosen country → E.164 (no validation of the region; the backend decides). */
export function toE164(country: Country, national: string): string | null {
  let digits = national.replace(/\D/g, '');
  if (country === 'US') {
    if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
    return /^[2-9]\d{9}$/.test(digits) ? `+1${digits}` : null;
  }
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}

export const LOCATION_MESSAGE = 'Aramo Sign Personal is currently available in the United States and India.';
export const NOT_OPEN_MESSAGE = 'Personal accounts aren’t open yet.';

export type StartFailure =
  | { kind: 'business_email' }
  | { kind: 'disposable' }
  | { kind: 'location' }
  | { kind: 'refused' }
  | { kind: 'invite_required' }
  | { kind: 'invite_invalid' }
  | { kind: 'not_open' }
  | { kind: 'rate_limited' }
  | { kind: 'field'; field: string; message: string }
  | { kind: 'other'; message: string };

/** The contract's refusal reasons for `start`, as one closed set the form renders. */
export function startFailure(err: PersonalSignupError): StartFailure {
  if (err.status === 404) return { kind: 'not_open' };
  if (err.status === 429) return { kind: 'rate_limited' };
  const r = err.reason ?? '';
  if (r === 'business_email_use_business_signup') return { kind: 'business_email' };
  if (r === 'personal_email_not_allowed') return { kind: 'disposable' };
  if (r === 'personal_location_not_supported') return { kind: 'location' };
  if (r === 'personal_signup_refused') return { kind: 'refused' };
  if (/invite/.test(r) && /(required|missing)/.test(r)) return { kind: 'invite_required' };
  if (/invite/.test(r)) return { kind: 'invite_invalid' };
  const field = err.details['field'];
  if (typeof field === 'string' && field !== '') return { kind: 'field', field, message: err.message };
  return { kind: 'other', message: err.message };
}

/** A one-time-code refusal (email or phone) in words the person can act on. */
export function codeFailureMessage(err: PersonalSignupError): { message: string; restart: boolean } {
  if (err.status === 404) return { message: 'This signup has expired. Start again.', restart: true };
  if (err.status === 429) return { message: 'Too many tries. Wait a minute and try again.', restart: false };
  const r = err.reason ?? '';
  if (/attempt|locked|exceeded/.test(r)) return { message: 'Too many wrong codes. Start again to get a new code.', restart: true };
  if (/expired/.test(r)) return { message: 'This code has expired. Send a new code.', restart: false };
  const left = err.details['attempts_remaining'];
  if (typeof left === 'number') {
    return { message: `That code isn’t right. ${left} ${left === 1 ? 'try' : 'tries'} left.`, restart: left <= 0 };
  }
  return { message: 'That code isn’t right. Check the code and try again.', restart: false };
}

const DOC_LABELS: Record<string, string> = {
  'sign.personal_terms_of_service': 'Aramo Sign Personal Terms of Service',
  'aramo.privacy_notice': 'Aramo Privacy Notice',
  'aramo.acceptable_use_policy': 'Aramo Acceptable Use Policy',
};

export function documentLabel(key: string): string {
  return DOC_LABELS[key] ?? key;
}

/** Cloudflare Turnstile site key: configured at build time; absent → no widget, robot_token null. */
export function turnstileSiteKey(): string | null {
  const v = (import.meta.env as Record<string, unknown>)['VITE_SIGN_TURNSTILE_SITE_KEY'];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}
