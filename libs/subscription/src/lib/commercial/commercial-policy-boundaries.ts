import type { CommercialPolicyContent } from './commercial-policy.js';

// CCP-A2 — the PURE boundary checks over the ACTIVE CommercialPolicyVersion. No I/O, no
// clock, no policy value: every number comes from the parsed policy document; the caller
// passes `now`. The comparison semantics are the PO-confirmed ones (2026-10-24,
// doc/ccp/slices/CCP-A2-pre-execution.md, "Boundary semantics"):
//
//   discount    ≥ threshold escalates (inclusive)
//   credit      ≥ threshold (minor units) escalates (inclusive)
//   extension   ≤ max days is within limit; more escalates
//   frequency   within limit only if NO in-limit extension applied in the rolling window
//               before now
//   cumulative  in-limit days in the rolling cumulative window, including this one, ≤ cap
//   expiry      expires `approval_expiry_hours` after it is submitted; AT exactly that instant
//               it is expired
//   grace       `past_due_grace_days`; at exactly the end of grace it has ended
//
// Time windows are half-open, consistently with the expiry rule: a duration that has
// fully elapsed AT `now` no longer covers `now`. So an extension applied exactly one
// frequency window ago has aged out of that window (and likewise for the cumulative
// window and for past-due grace, matching subscriptionSends' `grace_until > at`).
//
// A breach never applies (Charter §7): callers escalate. A2 wires none of these into a
// live path; A3/A8/C4 consume them, and the past-due lifecycle keeps reading its env
// value until the env-parity cutover (Charter §7, PBD §5 A2 out-of-scope note).

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export class CommercialPolicyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommercialPolicyInputError';
  }
}

function requireInt(name: string, v: number, min: number): void {
  if (!Number.isSafeInteger(v) || v < min) throw new CommercialPolicyInputError(`${name} must be an integer ≥ ${min}`);
}
function requireDate(name: string, d: Date): void {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) throw new CommercialPolicyInputError(`${name} must be a valid Date`);
}

// ---- Discount and credit escalation ---------------------------------------------------

/** A discount, in basis points (2000 = 20.00%), escalates when ≥ the policy threshold. */
export function discountEscalates(policy: CommercialPolicyContent, discount_bps: number): boolean {
  requireInt('discount_bps', discount_bps, 0);
  if (discount_bps > 10_000) throw new CommercialPolicyInputError('discount_bps must be ≤ 10000');
  return discount_bps >= policy.discount_escalation_threshold_bps;
}

export type CreditEscalation =
  | { escalates: false }
  | { escalates: true; reason: 'AT_OR_ABOVE_THRESHOLD' | 'CURRENCY_NOT_COVERED' };

/**
 * A credit escalates when its amount (minor units) is ≥ the threshold. A credit in a
 * currency the policy does not denominate escalates too (fail closed: no conversion).
 */
export function creditEscalation(policy: CommercialPolicyContent, credit: { amount_minor: number; currency: string }): CreditEscalation {
  requireInt('amount_minor', credit.amount_minor, 0);
  if (credit.currency !== policy.currency) return { escalates: true, reason: 'CURRENCY_NOT_COVERED' };
  return credit.amount_minor >= policy.credit_escalation_threshold_minor
    ? { escalates: true, reason: 'AT_OR_ABOVE_THRESHOLD' }
    : { escalates: false };
}

// ---- Support extension ----------------------------------------------------------------

/** One in-limit extension already applied to the same tenant × product. */
export interface AppliedSupportExtension {
  applied_at: Date;
  days: number;
}

export type SupportExtensionBreach = 'LENGTH' | 'FREQUENCY' | 'CUMULATIVE';

export interface SupportExtensionCheck {
  within_limit: boolean;
  breaches: SupportExtensionBreach[];
  /** Counter snapshot for the audit event (Recon Report §1 C1). */
  counters: {
    requested_days: number;
    extensions_in_frequency_window: number;
    cumulative_days_before: number;
    cumulative_days_after: number;
  };
}

/** True when `at` is inside the half-open window (now − days, +∞). Future rows count (fail closed). */
function inWindow(at: Date, now: Date, days: number): boolean {
  return at.getTime() > now.getTime() - days * DAY_MS;
}

/**
 * Checks a requested support extension against the policy. `prior` lists the in-limit
 * extensions already applied to the same tenant × product (any order, any age).
 */
export function checkSupportExtension(
  policy: CommercialPolicyContent,
  input: { requested_days: number; now: Date; prior: readonly AppliedSupportExtension[] },
): SupportExtensionCheck {
  requireInt('requested_days', input.requested_days, 1);
  requireDate('now', input.now);
  for (const p of input.prior) {
    requireDate('prior.applied_at', p.applied_at);
    requireInt('prior.days', p.days, 1);
  }
  const breaches: SupportExtensionBreach[] = [];
  if (input.requested_days > policy.support_extension_max_days) breaches.push('LENGTH');

  const inFrequency = input.prior.filter((p) => inWindow(p.applied_at, input.now, policy.support_extension_frequency_window_days)).length;
  if (inFrequency > 0) breaches.push('FREQUENCY');

  const before = input.prior
    .filter((p) => inWindow(p.applied_at, input.now, policy.support_extension_cumulative_window_days))
    .reduce((sum, p) => sum + p.days, 0);
  const after = before + input.requested_days;
  if (after > policy.support_extension_cumulative_max_days) breaches.push('CUMULATIVE');

  return {
    within_limit: breaches.length === 0,
    breaches,
    counters: {
      requested_days: input.requested_days,
      extensions_in_frequency_window: inFrequency,
      cumulative_days_before: before,
      cumulative_days_after: after,
    },
  };
}

// ---- Approval expiry ------------------------------------------------------------------

export function approvalExpiresAt(policy: CommercialPolicyContent, submitted_at: Date): Date {
  requireDate('submitted_at', submitted_at);
  return new Date(submitted_at.getTime() + policy.approval_expiry_hours * HOUR_MS);
}

/** Expired AT exactly `approval_expiry_hours` after it is submitted (PO-confirmed). */
export function isApprovalExpired(policy: CommercialPolicyContent, submitted_at: Date, now: Date): boolean {
  requireDate('now', now);
  return now.getTime() >= approvalExpiresAt(policy, submitted_at).getTime();
}

// ---- Past-due grace -------------------------------------------------------------------

export function pastDueGraceUntil(policy: CommercialPolicyContent, past_due_at: Date): Date {
  requireDate('past_due_at', past_due_at);
  return new Date(past_due_at.getTime() + policy.past_due_grace_days * DAY_MS);
}

/** Within grace strictly before its end (same edge as subscriptionSends: grace_until > at). */
export function isWithinPastDueGrace(policy: CommercialPolicyContent, past_due_at: Date, now: Date): boolean {
  requireDate('now', now);
  return pastDueGraceUntil(policy, past_due_at).getTime() > now.getTime();
}
