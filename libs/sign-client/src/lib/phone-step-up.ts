// SIGN-FREE-PARITY-1 S2 (FP-R2) — the new-account send check, self-serve. When a young
// Personal account's send is refused with `phone_verification_required`, sign-web and the
// app offer to verify the phone with a texted code (v1/sign/personal/step-up). The server
// decides: it says whether self-serve is available (GET status) and checks the code. This
// file is the ONE copy of the client wording and the client-side code rule.
//
// When self-serve is off (SIGN_SENDER_PHONE_STEP_UP unset), status says available=false
// and the clients keep today's plain refusal message.
import { PHONE_HINT } from './validation.js';

export const PHONE_STEP_UP_REASON = 'phone_verification_required';

/** The server's code length (identity personal-otp.ts: 6 digits). */
export const STEP_UP_CODE_LENGTH = 6;

export interface PhoneStepUpStatus {
  readonly available: boolean;
  readonly required: boolean;
  readonly phone_masked: string | null;
}

/** Offer the verify screen: the send was refused for the phone step and self-serve is on. */
export function offersPhoneStepUp(reason: string | null | undefined, status: PhoneStepUpStatus | null | undefined): boolean {
  return reason === PHONE_STEP_UP_REASON && status?.available === true && status.required;
}

/** The code as typed, digits only (spaces and dashes dropped), at most 6. */
export function normalizeStepUpCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, STEP_UP_CODE_LENGTH);
}

export function isStepUpCode(raw: string): boolean {
  return new RegExp(`^\\d{${STEP_UP_CODE_LENGTH}}$`).test(raw);
}

export const PHONE_STEP_UP_COPY = {
  title: 'Verify your phone to send',
  intro: 'New accounts verify a phone number before sending to more than one person. We’ll text you a 6-digit code.',
  sendTo: (masked: string): string => `We’ll text a code to ${masked}.`,
  sentTo: (masked: string): string => `We texted a code to ${masked}. It expires in 10 minutes.`,
  phoneLabel: 'Mobile number',
  phoneHint: PHONE_HINT,
  useAnotherNumber: 'Use another number',
  sendCode: 'Text me a code',
  // SMS-OPTIN-1 (LOCKED 2026-11-28) — the 10DLC opt-in disclosure, shown with the button every time.
  smsDisclosure: 'We’ll text one 6-digit code to this number. Msg & data rates may apply. Reply STOP to opt out.',
  sending: 'Sending…',
  codeLabel: '6-digit code',
  verify: 'Verify',
  verifying: 'Verifying…',
  resend: 'Send a new code',
  resendIn: (seconds: number): string => `You can ask for a new code in ${seconds} s.`,
  codeIncomplete: 'Enter the 6-digit code.',
  verified: 'Your phone is verified. You can send now.',
  sendNow: 'Send now',
  cancel: 'Cancel',
  close: 'Close',
} as const;

/** The refusals of the step-up routes (merged into REFUSAL_COPY). */
export const PHONE_STEP_UP_REFUSAL_COPY: Readonly<Record<string, string>> = {
  step_up_not_available: 'Phone verification isn’t available right now. We’ll review your account instead.',
  step_up_not_required: 'Your phone number is already verified. You can send now.',
  step_up_owner_only: 'Only the account owner can verify the phone number.',
  phone_required: 'Enter your mobile number.',
  phone_in_use: 'This number is already used by another account. Use a different number.',
  personal_code_rate_limited: 'Wait a minute before asking for another code.',
  phone_opted_out: 'This number has turned off texts from Aramo. Use another number.',
  step_up_sms_not_sent: 'We couldn’t send the text. Try again in a few minutes.',
};
