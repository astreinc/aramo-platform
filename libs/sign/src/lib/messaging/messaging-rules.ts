import { createHash } from 'node:crypto';

// Aramo-Sign-Feature-Parity-Program-Directive-v1_0-LOCKED §1.7 / §1.8 / §1.9 — the pure
// rules of Sign messaging: phone-number validation and masking, the opt-out keywords
// (STOP), quiet hours, per-tenant rate limits, and the ledger event names. No I/O.

// ── Ledger event types (SignatureEvent.event_type). Appended through the existing
// EsignRepository.appendEvent, so the hash chain is computed exactly as for every other
// event. A message event is never appended to a terminal envelope (the certificate's
// event-chain hash is final at completion): the delivery row records it instead.
export const SIGNER_MESSAGE_SENT_EVENT = 'SIGNER_MESSAGE_SENT';
export const SIGNER_MESSAGE_FAILED_EVENT = 'SIGNER_MESSAGE_FAILED';
export const SIGNER_MESSAGE_SUPPRESSED_EVENT = 'SIGNER_MESSAGE_SUPPRESSED';
export const SIGNER_MESSAGE_STATUS_EVENT = 'SIGNER_MESSAGE_STATUS';
export const RECIPIENT_OTP_SENT_EVENT = 'RECIPIENT_OTP_SENT';
export const RECIPIENT_OTP_VERIFIED_EVENT = 'RECIPIENT_OTP_VERIFIED';
export const RECIPIENT_OTP_FAILED_EVENT = 'RECIPIENT_OTP_FAILED';
export const RECIPIENT_OTP_LOCKED_EVENT = 'RECIPIENT_OTP_LOCKED';

export const MESSAGING_LEDGER_EVENT_TYPES: readonly string[] = [
  SIGNER_MESSAGE_SENT_EVENT,
  SIGNER_MESSAGE_FAILED_EVENT,
  SIGNER_MESSAGE_SUPPRESSED_EVENT,
  SIGNER_MESSAGE_STATUS_EVENT,
  RECIPIENT_OTP_SENT_EVENT,
  RECIPIENT_OTP_VERIFIED_EVENT,
  RECIPIENT_OTP_FAILED_EVENT,
  RECIPIENT_OTP_LOCKED_EVENT,
];

/** The recipient authentication method this module implements (§1.9). */
export const SMS_OTP_METHOD = 'SMS_OTP';

// ── Phone numbers ────────────────────────────────────────────────────────────
const E164 = /^\+[1-9]\d{7,14}$/;

/** E.164: a plus sign, a non-zero country digit, 8 to 15 digits in all. No spaces. */
export function isE164(value: unknown): value is string {
  return typeof value === 'string' && E164.test(value);
}

/** "+14155550123" → "+1•••••••23". Shown in the console, the ledger and the certificate. */
export function maskPhone(e164: string): string {
  const digits = e164.slice(1);
  if (digits.length < 4) return '+••';
  return `+${digits[0]}${'•'.repeat(digits.length - 3)}${digits.slice(-2)}`;
}

/**
 * The lookup key of a number in the opt-out list and the delivery records. A plain,
 * domain-separated SHA-256: it lets Aramo honour STOP for a number without keeping the
 * number itself in those tables. (It is a lookup key, not a secret.)
 */
export function phoneHash(e164: string): string {
  return createHash('sha256').update(`aramo-sign-messaging:${e164}`, 'utf8').digest('hex');
}

// ── Opt-out keywords (§1.7 "opt-out") ──────────────────────────────────────────
// The CTIA / carrier standard keywords. Matched on the whole trimmed message, case-blind.
const OPT_OUT_KEYWORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'OPT-OUT', 'REVOKE']);
const OPT_IN_KEYWORDS = new Set(['START', 'UNSTOP']);
const HELP_KEYWORDS = new Set(['HELP', 'INFO']);

export type InboundKeyword = 'OPT_OUT' | 'OPT_IN' | 'HELP';

export function parseInboundKeyword(body: unknown): InboundKeyword | null {
  if (typeof body !== 'string') return null;
  const word = body.trim().toUpperCase();
  if (OPT_OUT_KEYWORDS.has(word)) return 'OPT_OUT';
  if (OPT_IN_KEYWORDS.has(word)) return 'OPT_IN';
  if (HELP_KEYWORDS.has(word)) return 'HELP';
  return null;
}

// ── Quiet hours (§1.7) ───────────────────────────────────────────────────────
// A window in the RECIPIENT's local time during which no signing-link message is sent
// (TCPA practice in the US: nothing before 8:00 or after 21:00). SIGN_MESSAGING_QUIET_HOURS
// "START-END" in whole hours, default "21-8"; "off" disables. A one-time code is exempt:
// the recipient asked for it, at that moment.
export interface QuietHours {
  start: number; // first quiet hour, 0..23
  end: number; // first allowed hour, 0..23
}

export const DEFAULT_QUIET_HOURS: QuietHours = { start: 21, end: 8 };

export function quietHoursFromEnv(env: NodeJS.ProcessEnv = process.env): QuietHours | null {
  const raw = env['SIGN_MESSAGING_QUIET_HOURS']?.trim().toLowerCase();
  if (raw === undefined || raw === '') return DEFAULT_QUIET_HOURS;
  if (raw === 'off') return null;
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (m === null) return DEFAULT_QUIET_HOURS;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start > 23 || end > 23 || start === end) return DEFAULT_QUIET_HOURS;
  return { start, end };
}

/** True when the IANA zone name is one the runtime knows. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function localHour(now: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now);
  return Number(h) % 24;
}

function inWindow(hour: number, q: QuietHours): boolean {
  return q.start < q.end ? hour >= q.start && hour < q.end : hour >= q.start || hour < q.end;
}

// When the sender gave no time zone, the country decides. A North American number could
// be in any of the contiguous US zones, so it is quiet if it is quiet in ANY of them.
const NANP_ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];

export function recipientTimeZones(e164: string, timezone: string | null, env: NodeJS.ProcessEnv = process.env): string[] {
  if (timezone !== null && isTimeZone(timezone)) return [timezone];
  if (e164.startsWith('+1')) return NANP_ZONES;
  if (e164.startsWith('+91')) return ['Asia/Kolkata'];
  const fallback = env['SIGN_MESSAGING_DEFAULT_TIMEZONE']?.trim();
  return [fallback !== undefined && isTimeZone(fallback) ? fallback : 'UTC'];
}

export function isQuietHours(now: Date, zones: readonly string[], q: QuietHours | null): boolean {
  if (q === null) return false;
  return zones.some((z) => inWindow(localHour(now, z), q));
}

// ── Per-tenant rate limits (§1.7) ────────────────────────────────────────────
// Messages SENT (every channel and purpose) per tenant in the last hour and day.
// SIGN_MESSAGING_TENANT_HOURLY_LIMIT (default 100) / SIGN_MESSAGING_TENANT_DAILY_LIMIT
// (default 500). A message over the limit is SUPPRESSED (rate_limited), never queued.
export interface TenantMessagingLimits {
  hourly: number;
  daily: number;
}

export const DEFAULT_TENANT_MESSAGING_LIMITS: TenantMessagingLimits = { hourly: 100, daily: 500 };

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function tenantMessagingLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): TenantMessagingLimits {
  return {
    hourly: positiveInt(env['SIGN_MESSAGING_TENANT_HOURLY_LIMIT'], DEFAULT_TENANT_MESSAGING_LIMITS.hourly),
    daily: positiveInt(env['SIGN_MESSAGING_TENANT_DAILY_LIMIT'], DEFAULT_TENANT_MESSAGING_LIMITS.daily),
  };
}

export function rateLimitExceeded(counts: { last_hour: number; last_day: number }, limits: TenantMessagingLimits): boolean {
  return counts.last_hour >= limits.hourly || counts.last_day >= limits.daily;
}

// ── SMS OTP (§1.9) ───────────────────────────────────────────────────────────
// The code itself reuses the Personal OTP rules (@aramo/identity personal-otp: 6 digits,
// 10 minutes, 5 attempts per code, 60 s between sends, 5 sends a day). On top of those,
// a signer whose codes were exhausted OTP_MAX_LOCKED_CHALLENGES times is locked out of
// this envelope: only the sender can help (void and resend, or change the recipient).
export const OTP_MAX_LOCKED_CHALLENGES = 3;
