import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

// Aramo-Sign-Personal-Free-Launch-Directive-v1_1 (LOCKED) §3.2 / §6.3 — one-time
// codes for the email and phone checks. Generated and hashed by Aramo (never a
// provider's code): 6 digits, valid 10 minutes, at most 5 attempts; a resend is
// allowed after 60 seconds, up to 5 sends a day. Only the SHA-256 is stored, bound
// to the signup and the channel so a code for one cannot answer the other.

export const PERSONAL_OTP_DIGITS = 6;
export const PERSONAL_OTP_TTL_MS = 10 * 60 * 1000;
export const PERSONAL_OTP_MAX_ATTEMPTS = 5;
export const PERSONAL_OTP_RESEND_GAP_MS = 60 * 1000;
export const PERSONAL_OTP_MAX_SENDS_PER_DAY = 5;

export type PersonalOtpChannel = 'email' | 'phone';

export function generatePersonalOtp(): string {
  return String(randomInt(0, 10 ** PERSONAL_OTP_DIGITS)).padStart(PERSONAL_OTP_DIGITS, '0');
}

export function hashPersonalOtp(signup_id: string, channel: PersonalOtpChannel, code: string): string {
  return createHash('sha256').update(`${signup_id}:${channel}:${code}`, 'utf8').digest('hex');
}

export interface PersonalOtpState {
  hash: string | null;
  expires_at: Date | null;
  attempts: number;
}

export type PersonalOtpCheck = 'ok' | 'mismatch' | 'expired' | 'exhausted' | 'none';

/**
 * Check a submitted code against the stored state. The caller records an attempt
 * for every outcome other than 'none' / 'exhausted' / 'expired' BEFORE answering.
 */
export function checkPersonalOtp(state: PersonalOtpState, signup_id: string, channel: PersonalOtpChannel, code: unknown, now: Date): PersonalOtpCheck {
  if (state.hash === null || state.expires_at === null) return 'none';
  if (state.attempts >= PERSONAL_OTP_MAX_ATTEMPTS) return 'exhausted';
  if (state.expires_at.getTime() <= now.getTime()) return 'expired';
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return 'mismatch';
  const want = Buffer.from(state.hash, 'hex');
  const got = Buffer.from(hashPersonalOtp(signup_id, channel, code.trim()), 'hex');
  return want.length === got.length && timingSafeEqual(want, got) ? 'ok' : 'mismatch';
}

/** May another code be sent now? (60 s gap; at most 5 sends in the last 24 h). */
export function mayResendPersonalOtp(args: { last_sent_at: Date | null; sends_last_24h: number; now: Date }): boolean {
  if (args.sends_last_24h >= PERSONAL_OTP_MAX_SENDS_PER_DAY) return false;
  return args.last_sent_at === null || args.now.getTime() - args.last_sent_at.getTime() >= PERSONAL_OTP_RESEND_GAP_MS;
}
