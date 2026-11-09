// Aramo Sign Personal (Free) native signup — the pure model (M-A11 §1, §4). Ported from
// apps/sign-web/src/workspace/routes/personal-signup-api.ts (`COUNTRIES`, `toE164`,
// `startFailure`, `codeFailureMessage`) so the app and the web read the server the same
// way. Nothing here decides eligibility, risk or access: the backend does. Every refusal
// renders native copy; server prose is never shown.
import type { ApiError } from '../../api/errors';

export type Country = 'US' | 'IN';

/** The only two countries a Personal account is offered in (Personal v1.1 §6.6). */
export const COUNTRIES: readonly { code: Country; name: string; dial: string }[] = [
  { code: 'US', name: 'United States', dial: '+1' },
  { code: 'IN', name: 'India', dial: '+91' },
];

export type NextStep = 'phone' | 'terms' | 'review';

/** What the new account waits for before sending (Personal v1.1 §6.3). */
export type Held = 'review' | 'phone_verification_required' | null;

/** The national number typed by the person + the chosen country → E.164 (the backend decides the region). */
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

export const maskPhone = (e164: string | null): string => {
  if (e164 === null) return 'your mobile phone';
  const cc = e164.startsWith('+91') ? '+91' : '+1';
  return `${cc} ••• ••• ${e164.slice(-4)}`;
};

export const isGmail = (email: string): boolean => /@(gmail|googlemail)\.com$/i.test(email.trim());

export const RESEND_SECONDS = 60;

export const SIGNUP_COPY = {
  unavailable: 'Creating an account isn’t available in this version.',
  notOpen: 'Personal accounts aren’t open yet',
  location: 'Aramo Sign Personal is currently available in the United States and India.',
  businessEmail:
    'That looks like a work email. Personal accounts use a personal email address, like Gmail. Use your personal email, or create a Business account at sign.aramo.ai.',
  disposable: 'Disposable email addresses aren’t allowed. Use your personal email address.',
  inviteRequired: 'Personal accounts are invite-only right now. Enter your invite code.',
  inviteInvalid: 'This invite code isn’t valid for this email, or it has expired.',
  pilotFull: 'Personal accounts are full right now. Try again later.',
  rateLimited: 'Too many attempts. Wait a few minutes and try again.',
  integrityFailed: 'We couldn’t check this device with Google Play. Try again.',
  // Apple Go-Live W5: no "Google Play" on iOS (App Attest).
  integrityFailedIos: 'We couldn’t check this device. Try again.',
  generic: 'Something went wrong. Try again.',
  privacy: 'We use your details as described in our Privacy Notice.',
  phoneHelp: 'Used only to verify your account and keep it secure — never for marketing.',
  emailHelp:
    'Gmail, Outlook.com, Yahoo and similar. You’ll sign in with Google or Apple for this address.',
  // Apple Go-Live R-5: the address Apple shared (real or Hide My Email) is locked.
  applePrefilled:
    'We filled in the email Apple shared. We’ll still send a code to it to confirm it’s yours.',
  maxmind:
    'This product includes GeoLite2 data created by MaxMind, available from https://www.maxmind.com.',
  reviewTitle: 'We’re reviewing your account…',
  reviewBody: (email: string) =>
    `Thanks. We review some new signups before an account can be created. If your details can be used, we’ll email you at ${email}.`,
  termsChanged:
    'The terms changed while you were signing up. Read the current versions and accept again.',
  termsLoadFailed: 'We couldn’t load the terms. Try again.',
  privacyLoadFailed: 'We couldn’t load the Privacy Notice. Try again.',
  termsUnavailable:
    'Your email is confirmed, but we can’t create personal accounts yet. Please try again later.',
  expiredTitle: 'This signup has expired',
  expiredBody: 'Start again and we’ll send you a new code.',
  emailTaken: 'This email already has an Aramo account. Sign in instead.',
  stillCreating: 'Your account is still being created. Try again in a moment.',
  doneTitle: 'Your account is ready.',
  doneBody: (email: string) => `Sign in with Google or Apple. Use the account for ${email}.`,
  doneBodyApple: 'Sign in with Apple to finish. Use the same Apple ID.',
  doneInactive: 'Your account stays inactive until you sign in.',
  gmail:
    'Sign-in must match this address exactly. If Google shows your address with dots (for example pat.lee@gmail.com), it must be entered the same way here.',
  phoneUnavailable:
    'Phone verification is temporarily unavailable. You can still create your account.',
  phoneSendFailed: 'We couldn’t send a code to your phone',
} as const;

/** The device-check failure in the platform's words (no "Google Play" on iOS). */
export function integrityFailedCopy(client: 'android' | 'ios'): string {
  return client === 'ios' ? SIGNUP_COPY.integrityFailedIos : SIGNUP_COPY.integrityFailed;
}

export const HELD_COPY: Record<Exclude<Held, null>, { title: string; note: string }> = {
  review: {
    title: 'We’re reviewing your account',
    note: 'Your account is being reviewed. You can sign in, but sending is paused until the review is done (usually within 1 business day).',
  },
  phone_verification_required: {
    title: 'Sending needs a verified phone',
    note: 'To send documents you’ll need to verify your phone. Phone verification is temporarily unavailable — we’ll let you know when it’s ready.',
  },
};

export type StartFailure =
  | { kind: 'business_email' }
  | { kind: 'disposable' }
  | { kind: 'location' }
  | { kind: 'refused' }
  | { kind: 'invite_required' }
  | { kind: 'invite_invalid' }
  | { kind: 'pilot_full' }
  | { kind: 'not_open' }
  | { kind: 'rate_limited' }
  | { kind: 'field'; field: string }
  | { kind: 'other' };

type Refusal = Pick<ApiError, 'status' | 'reason' | 'details'>;

/** The contract's refusal reasons for `start`, as one closed set the form renders. */
export function startFailure(err: Refusal): StartFailure {
  if (err.status === 404) return { kind: 'not_open' };
  if (err.status === 429) return { kind: 'rate_limited' };
  const r = err.reason ?? '';
  if (r === 'business_email_use_business_signup') return { kind: 'business_email' };
  if (r === 'personal_email_not_allowed') return { kind: 'disposable' };
  if (r === 'personal_location_not_supported') return { kind: 'location' };
  if (r === 'personal_signup_refused') return { kind: 'refused' };
  if (r === 'personal_pilot_full') return { kind: 'pilot_full' };
  if (/invite/.test(r) && /(required|missing)/.test(r)) return { kind: 'invite_required' };
  if (/invite/.test(r)) return { kind: 'invite_invalid' };
  const field = err.details['field'];
  if (typeof field === 'string' && field !== '') return { kind: 'field', field };
  return { kind: 'other' };
}

/** Native copy for a start refusal shown as a form-level message (null: handled elsewhere). */
export function startFailureMessage(f: StartFailure): string | null {
  switch (f.kind) {
    case 'business_email':
      return SIGNUP_COPY.businessEmail;
    case 'disposable':
      return SIGNUP_COPY.disposable;
    case 'location':
      return SIGNUP_COPY.location;
    case 'pilot_full':
      return SIGNUP_COPY.pilotFull;
    case 'rate_limited':
      return SIGNUP_COPY.rateLimited;
    case 'invite_required':
      return SIGNUP_COPY.inviteRequired;
    case 'invite_invalid':
      return SIGNUP_COPY.inviteInvalid;
    case 'refused':
    case 'not_open':
      return null;
    default:
      return SIGNUP_COPY.generic;
  }
}

/** A one-time-code refusal (email or phone) in words the person can act on. */
export function codeFailureMessage(err: Refusal): { message: string; restart: boolean } {
  if (err.status === 404)
    return { message: 'This signup has expired. Start again.', restart: true };
  if (err.status === 429)
    return { message: 'Too many tries. Wait a minute and try again.', restart: false };
  const r = err.reason ?? '';
  if (/rate_limited/.test(r))
    return { message: 'Too many tries. Wait a minute and try again.', restart: false };
  if (/attempt|locked|exceeded/.test(r))
    return { message: 'Too many wrong codes. Start again to get a new code.', restart: true };
  if (/expired/.test(r))
    return { message: 'This code has expired. Send a new code.', restart: false };
  const left = err.details['attempts_remaining'];
  if (typeof left === 'number') {
    return {
      message: `That code isn’t right. ${left} ${left === 1 ? 'try' : 'tries'} left.`,
      restart: left <= 0,
    };
  }
  return { message: 'That code isn’t right. Check the code and try again.', restart: false };
}

const DOC_LABELS: Record<string, string> = {
  'sign.terms_of_service': 'Aramo Sign Terms of Service',
  'sign.personal_terms_of_service': 'Aramo Sign Personal Terms of Service',
  'aramo.privacy_notice': 'Aramo Privacy Notice',
  'aramo.acceptable_use_policy': 'Aramo Acceptable Use Policy',
};

export function documentLabel(key: string): string {
  return DOC_LABELS[key] ?? key;
}

export type FieldKey = 'name' | 'email' | 'phone' | 'residence' | 'invite';
/** Residence choice: '' until chosen. Only US / IN are offered (no "another country" in the app). */
export type Residence = '' | Country;

export interface DetailsInput {
  readonly name: string;
  readonly email: string;
  readonly country: Country;
  readonly phone: string;
  readonly residence: Residence;
  readonly invite: string;
  readonly inviteRequired: boolean;
}

/** Client-side checks before `start` (the same as the web form); the server re-checks everything. */
export function validateDetails(d: DetailsInput): {
  errors: Partial<Record<FieldKey, string>>;
  e164: string | null;
} {
  const errors: Partial<Record<FieldKey, string>> = {};
  if (d.name.trim().length < 2) errors.name = 'Enter your full name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim()))
    errors.email = 'Enter your email address.';
  const e164 = toE164(d.country, d.phone);
  if (e164 === null)
    errors.phone =
      d.country === 'US'
        ? 'Enter a 10-digit US mobile number.'
        : 'Enter a 10-digit Indian mobile number.';
  if (d.residence === '') errors.residence = 'Choose where you live.';
  if (d.inviteRequired && d.invite.trim() === '') errors.invite = 'Enter your invite code.';
  return { errors, e164 };
}

/** Native copy for a server field refusal (details.field), or null for an unknown field. */
export function fieldMessage(field: string, country: Country): string | null {
  switch (field) {
    case 'name':
      return 'Enter your full name.';
    case 'email':
      return 'Enter your email address.';
    case 'phone':
      return country === 'US'
        ? 'Enter a 10-digit US mobile number.'
        : 'Enter a 10-digit Indian mobile number.';
    case 'residence':
      return 'Choose where you live.';
    case 'invite':
    case 'invite_code':
      return 'Enter your invite code.';
    default:
      return null;
  }
}
