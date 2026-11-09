import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

// Apple Go-Live Amendment A1 (LOCKED) L-4 (b) — the email-code proof for a pending
// identity link. The same rules as the Personal signup codes
// (personal/personal-otp.ts, Sign Personal Free Launch v1.1 §3.2), copied here
// rather than shared so the signup module stays independent: 6 digits, valid
// 10 minutes, at most 5 attempts; a resend after 60 seconds, at most 5 sends a
// day per handle and per account. Only the SHA-256 is stored, bound to the
// pending link so a code for one link cannot answer another.

export const LINK_OTP_DIGITS = 6;
export const LINK_OTP_TTL_MS = 10 * 60 * 1000;
export const LINK_OTP_MAX_ATTEMPTS = 5;
export const LINK_OTP_RESEND_GAP_MS = 60 * 1000;
export const LINK_OTP_MAX_SENDS_PER_DAY = 5;

export function generateLinkOtp(): string {
  return String(randomInt(0, 10 ** LINK_OTP_DIGITS)).padStart(LINK_OTP_DIGITS, '0');
}

export function hashLinkOtp(link_id: string, code: string): string {
  return createHash('sha256').update(`${link_id}:link_email:${code}`, 'utf8').digest('hex');
}

export interface LinkOtpState {
  hash: string | null;
  expires_at: Date | null;
  attempts: number;
}

// 'none' = no code was ever issued for this link (for example an unknown email at
// start): the caller answers exactly as for a wrong code, so the verify step is
// not an oracle for whether a code was sent.
export type LinkOtpCheck = 'ok' | 'mismatch' | 'expired' | 'exhausted' | 'none';

export function checkLinkOtp(state: LinkOtpState, link_id: string, code: unknown, now: Date): LinkOtpCheck {
  if (state.attempts >= LINK_OTP_MAX_ATTEMPTS) return 'exhausted';
  if (state.hash === null || state.expires_at === null) return 'none';
  if (state.expires_at.getTime() <= now.getTime()) return 'expired';
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return 'mismatch';
  const want = Buffer.from(state.hash, 'hex');
  const got = Buffer.from(hashLinkOtp(link_id, code.trim()), 'hex');
  return want.length === got.length && timingSafeEqual(want, got) ? 'ok' : 'mismatch';
}

/** May another code be sent now? (60 s gap; at most 5 sends in the window.) */
export function mayResendLinkOtp(args: { last_sent_at: Date | null; sends: number; now: Date }): boolean {
  if (args.sends >= LINK_OTP_MAX_SENDS_PER_DAY) return false;
  return args.last_sent_at === null || args.now.getTime() - args.last_sent_at.getTime() >= LINK_OTP_RESEND_GAP_MS;
}
