// SMS-CONSENT-1 (LOCKED 2026-11-28) — consent for texts to signers. ONE copy of the consent and
// certification wording, their versions, the signer SMS code text and the refusal copy, for the
// server (sign-service) and both Sign clients (sign-web, the app).
//
//   R-2  an organization owner / admin certifies once per organization that it obtains each
//        recipient's consent; signer SMS options stay off until certified.
//   R-3  a registered user opts in to texts themselves (verified number + a separate, unticked
//        consent). Per person, revocable in Settings or by replying STOP.
//   R-4  signer SMS (delivery by text, the SMS code before signing) is for Business plans.
//   R-6  the signer SMS code text ends with "Reply STOP to opt out."
//   R-8  everything is dark: `available` is false until the campaign and the legal texts are approved.
//
// The server decides every rule; the clients show what the API says. A changed wording gets a new
// version: a certification or consent recorded under an older version no longer counts.
import { PHONE_HINT } from './validation.js';

export const SMS_CERTIFICATION_WORDING_VERSION = '2026-11-28';
export const SMS_CERTIFICATION_WORDING =
  'I certify, on behalf of my organization, that we obtain each recipient’s consent before we send them text messages through Aramo Sign, and that we stop texting anyone who asks us to.';

export const SMS_CONSENT_WORDING_VERSION = '2026-11-28';
export const SMS_CONSENT_WORDING =
  'Let people who send me documents through Aramo Sign text me signing requests, reminders and signing codes. Msg & data rates may apply. Reply STOP to opt out, HELP for help.';

/** R-6 — the text of the code a signer (or a user verifying their own number) receives. */
export const SIGNER_SMS_CODE_TEXT = 'Your Aramo Sign verification code is {code}. It expires in {ttl} minutes. Do not share it. Reply STOP to opt out.';

export function signerSmsCodeText(code: string, ttl_minutes: number): string {
  return SIGNER_SMS_CODE_TEXT.replace('{code}', code).replace('{ttl}', String(ttl_minutes));
}

/** Where a user gave their consent (SignUserSmsConsent.consent_channel). */
export const SMS_CONSENT_CHANNELS = ['WEB', 'APP', 'SIGNUP'] as const;
export type SmsConsentChannel = (typeof SMS_CONSENT_CHANNELS)[number];

export function isSmsConsentChannel(value: unknown): value is SmsConsentChannel {
  return typeof value === 'string' && (SMS_CONSENT_CHANNELS as readonly string[]).includes(value);
}

// ── The API shapes (openapi/sign.yaml SmsCertification, UserSmsConsent) ─────────
/** GET /v1/sign/sender/sms-certification (and the POST / DELETE answers). */
export interface SmsCertificationView {
  readonly available: boolean;
  readonly required: boolean;
  readonly certified: boolean;
  readonly certified_at: string | null;
  readonly certified_by_name: string | null;
  readonly wording_version: string;
  readonly wording: string;
}

/** GET /v1/sign/me/sms-consent (and the answers of its writes). */
export interface UserSmsConsentView {
  readonly available: boolean;
  readonly phone_masked: string | null;
  readonly phone_verified: boolean;
  readonly consented: boolean;
  readonly consented_at: string | null;
  readonly wording_version: string;
  readonly wording: string;
}

/** POST /v1/sign/me/sms-consent/phone. */
export interface UserSmsCodeSent {
  readonly sent: true;
  readonly phone_masked: string;
  readonly expires_in_seconds: number;
  readonly resend_after_seconds: number;
}

/** The sender context's `sms_certification` member. */
export interface SenderSmsCertification {
  readonly required: boolean;
  readonly certified: boolean;
}

// ── Refusals (details.reason) ─────────────────────────────────────────────────
export const SMS_NOT_IN_PLAN_REASON = 'sms_not_in_plan';
export const SMS_CONSENT_NOT_CERTIFIED_REASON = 'sms_consent_not_certified';

/** The send flow's note when texts are launched and in the plan but nobody has certified yet. */
export const SMS_NOT_CERTIFIED_NOTE = 'An administrator must confirm SMS consent in Settings before texts can be sent.';

export const SMS_CONSENT_REFUSAL_COPY: Readonly<Record<string, string>> = {
  [SMS_NOT_IN_PLAN_REASON]: 'Text messages to signers come with Aramo Sign Business plans.',
  [SMS_CONSENT_NOT_CERTIFIED_REASON]: SMS_NOT_CERTIFIED_NOTE,
  sms_not_available: 'Text messages aren’t available yet.',
  sms_wording_outdated: 'The wording has changed. Read it again and confirm.',
  sms_consent_invalid: 'Something went wrong. Try again.',
  sms_channel_invalid: 'Something went wrong. Try again.',
  sms_phone_invalid: PHONE_HINT,
  sms_phone_not_supported: 'We can’t text this number yet. Use another mobile number.',
  sms_phone_not_verified: 'Verify your mobile number first.',
  sms_phone_opted_out: 'This number has turned off texts from Aramo. Reply START to Aramo’s texts to turn them back on, or use another number.',
  sms_code_rate_limited: 'Wait a minute before asking for another code.',
  sms_code_not_sent: 'We couldn’t send the text. Try again in a few minutes.',
  sms_code_not_requested: 'Ask for a code first.',
  sms_code_invalid: 'That code isn’t right. Check the code and try again.',
  sms_code_expired: 'This code has expired. Ask for a new one.',
  sms_code_attempts_exceeded: 'Too many wrong codes. Ask for a new code.',
  sms_code_retry: 'Please try again.',
};

// ── Screen words (organization settings, user settings, the step after signup) ──
export const SMS_CONSENT_COPY = {
  orgTitle: 'Text messages (SMS)',
  orgIntro: 'Before anyone in your organization can text signers, an owner or administrator confirms that you have their consent.',
  certify: 'Certify',
  withdraw: 'Withdraw',
  certifiedBy: (name: string | null, when: string): string => (name !== null && name.trim() !== '' ? `Certified by ${name.trim()} on ${when}.` : `Certified on ${when}.`),
  notCertified: 'Not certified. Texts to signers are off.',
  userTitle: 'Text messages',
  userIntro: 'Get signing requests, reminders and signing codes on your phone.',
  phoneLabel: 'Mobile number',
  phoneHint: PHONE_HINT,
  sendCode: 'Text me a code',
  codeLabel: '6-digit code',
  verify: 'Verify',
  verified: 'Your number is verified.',
  consentLabel: SMS_CONSENT_WORDING,
  turnOff: 'Turn off texts',
  remove: 'Remove number',
  signupTitle: 'Get signing requests by text',
  signupIntro: 'Add your mobile number so people who send you documents can text you. You can change this any time in Settings.',
  skip: 'Skip',
  sendFlowNotCertified: SMS_NOT_CERTIFIED_NOTE,
} as const;

/**
 * The send flow's text options (SMS delivery / SMS code), from the sender context: offered (the
 * server reports the feature on), needs_certification (launched and in the plan, nobody certified:
 * show SMS_NOT_CERTIFIED_NOTE instead of the options) or hidden.
 */
export function smsSendOptionsState(
  features: { readonly sms_delivery?: boolean; readonly sms_otp?: boolean } | null | undefined,
  certification: SenderSmsCertification | null | undefined,
): 'offered' | 'needs_certification' | 'hidden' {
  if (features?.sms_delivery === true || features?.sms_otp === true) return 'offered';
  if (certification?.required === true && !certification.certified) return 'needs_certification';
  return 'hidden';
}
