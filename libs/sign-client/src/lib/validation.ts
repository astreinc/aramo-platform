// Client Rule Consolidation C3 (audit rows 18–24, 26–28; Appendix A) — the input limits and
// patterns the server enforces, in ONE copy that sign-service, apps/sign-web and mobile/sign
// all import (directive G-1, G-5: where copies disagreed, the server's enforced value wins).
// A client checks them only to tell the user before a save fails; the server still decides.

// ── envelope ─────────────────────────────────────────────────────────────────

/** Row 18 — the envelope subject (sender-envelope.service.ts MAX_TITLE). */
export const ENVELOPE_SUBJECT_MAX = 200;
/** Row 19 — the sender message, after sanitizing (envelope-contracts.ts MESSAGE_MAX). */
export const ENVELOPE_MESSAGE_MAX = 1000;
/** Row 20 — signing recipients per envelope (Multi-Signer). The 11th is refused, never converted. */
export const MAX_SIGNERS = 10;

export const SIGNERS_FULL_MESSAGE = `An envelope can have at most ${MAX_SIGNERS} signers.`;

// ── email (row 22) ───────────────────────────────────────────────────────────

/** Row 22 — the server's email pattern (Appendix A). */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Row 22 / 28 — at most 254 characters (RFC 5321 path limit, the server's cap). */
export const EMAIL_MAX = 254;

/** A recipient / delegate / contact email: trimmed, at most 254, the server's pattern. */
export function isValidEmail(email: string): boolean {
  const e = email.trim();
  return e.length > 0 && e.length <= EMAIL_MAX && EMAIL_PATTERN.test(e);
}

// ── access code (row 23) ─────────────────────────────────────────────────────

export const ACCESS_CODE_MIN_LENGTH = 4;
export const ACCESS_CODE_MAX_LENGTH = 32;
const PRINTABLE = /^[\x20-\x7E]+$/;

/** The trimmed code, or null when it is not 4 to 32 printable characters (the server's rule). */
export function normalizeAccessCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim();
  if (code.length < ACCESS_CODE_MIN_LENGTH || code.length > ACCESS_CODE_MAX_LENGTH) return null;
  return PRINTABLE.test(code) ? code : null;
}

export function isValidAccessCode(code: string): boolean {
  return normalizeAccessCode(code) !== null;
}

// ── phone (row 24) ───────────────────────────────────────────────────────────

/**
 * Row 24 — E.164: a plus sign, a non-zero country digit, then 7 to 14 digits (8 to 15 in
 * all). The ONE pattern: messaging (SMS / WhatsApp / SMS code) and the Sign profile phone
 * both use it (the profile's former `{1,14}` outlier is closed, directive §5).
 */
export const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

export function isE164(value: unknown): value is string {
  return typeof value === 'string' && E164_PATTERN.test(value);
}

export const PHONE_HINT = 'Use the international format, for example +14155550123';

// ── fields (row 26) ──────────────────────────────────────────────────────────

/** Row 26 — a checkbox label (sender-envelope.service.ts MAX_LABEL). */
export const CHECKBOX_LABEL_MAX = 200;
/** Row 26 — a checkbox group key (sender-envelope.service.ts MAX_GROUP_KEY). */
export const CHECKBOX_GROUP_KEY_MAX = 64;

// ── void, decline, delegate (rows 6, 27, 28) ─────────────────────────────────

/** Row 6 — a void reason: non-empty after trimming, at most 500 (mobile's minimum of 3 is dropped). */
export const VOID_REASON_MAX = 500;
export type ReasonProblem = 'required' | 'too_long';

export function voidReasonProblem(reason: string): ReasonProblem | null {
  const r = reason.trim();
  if (r.length === 0) return 'required';
  return r.length > VOID_REASON_MAX ? 'too_long' : null;
}

export const VOID_REASON_COPY: Readonly<Record<ReasonProblem, string>> = {
  required: 'Enter a reason. Recipients see that the envelope was voided.',
  too_long: `A reason can be up to ${VOID_REASON_MAX} characters.`,
};

/** Row 27 — a decline reason: non-empty after trimming (mobile's minimum of 3 is dropped). */
export function isValidDeclineReason(reason: string): boolean {
  return reason.trim().length > 0;
}

/** Row 28 — the delegate's name (the server caps it at 200) and reason (at most 500). */
export const DELEGATE_NAME_MAX = 200;
export const DELEGATE_REASON_MAX = 500;

export interface DelegateInput {
  readonly name: string;
  readonly email: string;
  readonly reason?: string;
}

/** Row 28 — a name, a valid email of at most 254 and a reason of at most 500 (the server checks again). */
export function isValidDelegate(input: DelegateInput): boolean {
  const name = input.name.trim();
  return name.length > 0 && name.length <= DELEGATE_NAME_MAX && isValidEmail(input.email) && (input.reason ?? '').trim().length <= DELEGATE_REASON_MAX;
}
