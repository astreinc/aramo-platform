// SIGN-FREE-PARITY-1 S3 — the one-time code a signer enters before the document opens, ONE
// copy for both Sign clients (sign-web guest page, mobile signing flow): a code texted to the
// signer's phone (Feature-Parity §1.9, SMS_OTP) or emailed to them (S3, EMAIL_OTP). The server
// sends, checks and counts every code; nothing here keeps one. The screen says plainly where
// the code goes.
//
// Server rule (sign-service RecipientOtpService): a signer who must enter both codes enters
// the SMS code first, then the email code. Every refusal names the code still due in
// details.method, so a client shows the step for that method.

export type SignerCodeMethod = 'SMS_OTP' | 'EMAIL_OTP';

/** The method a verification refusal or status names; an unknown or missing method is the SMS code (pre-S3 server). */
export function signerCodeMethodOf(method: unknown): SignerCodeMethod {
  return method === 'EMAIL_OTP' ? 'EMAIL_OTP' : 'SMS_OTP';
}

/** The signer-side route segment for each method: POST v1/sign/signing/verification/<segment>/send|verify. */
export const SIGNER_CODE_ROUTE: Readonly<Record<SignerCodeMethod, string>> = {
  SMS_OTP: 'sms-otp',
  EMAIL_OTP: 'email-otp',
};

export interface SignerCodeCopy {
  readonly title: string;
  /** Before a code is sent: where it will go (the masked phone or email, or a plain fallback). */
  readonly body: (destination: string | null) => string;
  /** After a code was sent. */
  readonly sentBody: (destination: string | null) => string;
  readonly sendLabel: string;
  readonly resendLabel: string;
  readonly continueLabel: string;
  readonly codeLabel: string;
}

export const SIGNER_CODE_COPY: Readonly<Record<SignerCodeMethod, SignerCodeCopy>> = {
  SMS_OTP: {
    title: 'Enter the code we text you',
    body: (phone) => `The sender asked us to confirm your phone before you open this document. We’ll text a code to ${phone ?? 'your phone'}.`,
    sentBody: (phone) => `We sent a 6-digit code to ${phone ?? 'your phone'}.`,
    sendLabel: 'Text me a code',
    resendLabel: 'Send a new code',
    continueLabel: 'Continue',
    codeLabel: 'Code',
  },
  EMAIL_OTP: {
    title: 'Enter the code we email you',
    body: (email) => `The sender asked us to confirm your email before you open this document. We’ll email a 6-digit code to ${email ?? 'your email'}.`,
    sentBody: (email) => `We sent a 6-digit code to ${email ?? 'your email'}. Check your inbox and spam folder.`,
    sendLabel: 'Email me a code',
    resendLabel: 'Send a new code',
    continueLabel: 'Continue',
    codeLabel: 'Code',
  },
};

export const SIGNER_CODE_LOCKED = {
  title: 'Too many incorrect codes',
  body: 'For your security this document is locked. Contact the sender if you still need to sign.',
} as const;

const SEND_REFUSALS: Readonly<Record<string, string>> = {
  otp_resend_cooldown: 'Wait a minute before asking for another code.',
  otp_daily_limit: 'You have asked for too many codes today. Try again tomorrow, or contact the sender.',
  otp_opted_out: 'This number has stopped text messages from Aramo Sign. Contact the sender.',
};

const VERIFY_REFUSALS: Readonly<Record<string, string>> = {
  otp_mismatch: 'That code isn’t right. Check it and try again.',
  otp_expired: 'This code has expired. Send a new one.',
  otp_code_locked: 'Too many incorrect codes. Send a new code.',
  otp_not_requested: 'Send a code first.',
};

/** The words for a refused send (details.reason); never the server's own message. */
export function signerCodeSendRefusal(reason: string | undefined): string {
  return (reason !== undefined ? SEND_REFUSALS[reason] : undefined) ?? 'The code couldn’t be sent. Try again in a moment.';
}

/** The words for a refused code check (details.reason). */
export function signerCodeVerifyRefusal(reason: string | undefined): string {
  return (reason !== undefined ? VERIFY_REFUSALS[reason] : undefined) ?? 'That didn’t go through. Try again.';
}

/** Send flow — the sender's option for one signer (web wizard and app recipient options). */
export const EMAIL_CODE_OPTION = {
  label: 'Ask for a code sent to their email before signing',
  hint: 'We email them a 6-digit code. They enter it before the document opens.',
} as const;
