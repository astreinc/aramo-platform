import type { CommercialPolicyContent } from './commercial-policy.js';
import { type AppliedSupportExtension, type SupportExtensionBreach, checkSupportExtension } from './commercial-policy-boundaries.js';

// CCP-A8 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.1 row A8; DDR v1.2 §3.2(5);
// Charter §7 D5; Recon Report §1 C1 and G1) — the PURE half of the support exception overlay.
// No I/O and no clock: the caller passes `now` and the facts it read under the billing lock.
//
// A support extension extends the SENDING window of ONE PAST_DUE subscription row past its
// grace, as an overlay row (never `grace_until`: the provider sync recomputes it, Recon G1):
//   base_until    = max(applied_at, grace_until at apply time)
//   extends_until = base_until + days
// The row then sends while `grace_until > at` OR an unremoved overlay has `extends_until > at`
// (half-open, TD-A2-1). It changes no allowance limit, no usage row and no billing period:
// allowance is never manufactured (T8).
//
// The bound (A2-B, TD-A2-1, Charter §7) is the A2 pure check over the ACTIVE policy; a limit breach
// (LENGTH, FREQUENCY, CUMULATIVE) ESCALATES (a NORMAL request, Finance per Q7) and NEVER applies
// (DDR v1.2 §3.2(5)). CCP-R3 (TD-A8-3 refined, Architect 2026-10-25): ELIGIBILITY is NOT a breach.
// A row that is not PAST_DUE, or a requester without an active D9 attestation, is an eligibility
// REFUSAL: a stable code, one audit row, nothing applied and nothing escalated to Finance. Only a
// defined policy violation (a limit breach) escalates.

const DAY_MS = 86_400_000;

/** Why a support extension is not admissible at all (CCP-R3: refused, never escalated). */
export type SupportExtensionEligibilityReason =
  // The row is not PAST_DUE: the overlay changes sending only for a PAST_DUE row (TD-A8).
  | 'SUBSCRIPTION_NOT_PAST_DUE'
  // The requester holds no active D9 one-account-per-human attestation: a zero-approval act
  // needs a human-attested actor (D9; TD-A8).
  | 'REQUESTER_NOT_ATTESTED';

/** CCP-R3: only a limit breach is an outcome breach (it escalates); ELIGIBILITY is a refusal. */
export type SupportExtensionOutcomeBreach = SupportExtensionBreach;

export interface SupportExtensionDecision {
  /** CCP-R3: false → refused (SUPPORT_EXTENSION_INELIGIBLE), whatever the bounds say. */
  eligible: boolean;
  /** The limits only (LENGTH, FREQUENCY, CUMULATIVE): true → the bounded exception applies. */
  within_bounds: boolean;
  breaches: SupportExtensionOutcomeBreach[];
  eligibility: SupportExtensionEligibilityReason[];
  /** The A2 counter snapshot (Recon Report §1 C1), recorded on the audit event. */
  counters: {
    requested_days: number;
    extensions_in_frequency_window: number;
    cumulative_days_before: number;
    cumulative_days_after: number;
  };
  /** The policy clause applied (evidence). */
  clause: {
    support_extension_max_days: number;
    support_extension_frequency_window_days: number;
    support_extension_cumulative_max_days: number;
    support_extension_cumulative_window_days: number;
  };
}

/**
 * Decides a requested support extension: eligibility (CCP-R3: an ineligible request is refused) and
 * bounds (A2 check over `prior` = EVERY extension already applied to this tenant × product, bounded
 * or approved, removed or not; fail closed, TD-A8). Pure.
 */
export function decideSupportExtension(
  policy: CommercialPolicyContent,
  input: {
    requested_days: number;
    now: Date;
    prior: readonly AppliedSupportExtension[];
    subscription_status: string;
    requester_attested: boolean;
  },
): SupportExtensionDecision {
  const bound = checkSupportExtension(policy, { requested_days: input.requested_days, now: input.now, prior: input.prior });
  const eligibility: SupportExtensionEligibilityReason[] = [];
  if (input.subscription_status !== 'PAST_DUE') eligibility.push('SUBSCRIPTION_NOT_PAST_DUE');
  if (!input.requester_attested) eligibility.push('REQUESTER_NOT_ATTESTED');
  const breaches: SupportExtensionOutcomeBreach[] = [...bound.breaches];
  return {
    eligible: eligibility.length === 0,
    within_bounds: breaches.length === 0,
    breaches,
    eligibility,
    counters: bound.counters,
    clause: {
      support_extension_max_days: policy.support_extension_max_days,
      support_extension_frequency_window_days: policy.support_extension_frequency_window_days,
      support_extension_cumulative_max_days: policy.support_extension_cumulative_max_days,
      support_extension_cumulative_window_days: policy.support_extension_cumulative_window_days,
    },
  };
}

/** The overlay window (the DB CHECKs recompute the same). */
export function supportExtensionWindow(applied_at: Date, grace_until: Date | null, days: number): { base_until: Date; extends_until: Date } {
  if (!Number.isSafeInteger(days) || days < 1) throw new RangeError('days must be a positive integer');
  const base = Math.max(applied_at.getTime(), grace_until?.getTime() ?? applied_at.getTime());
  return { base_until: new Date(base), extends_until: new Date(base + days * DAY_MS) };
}

/** True when an overlay keeps a PAST_DUE row sending at `at` (half-open; a removed overlay never does). */
export function overlayCovers(overlay: { extends_until: Date; removed_at: Date | null }, at: Date): boolean {
  return overlay.removed_at === null && overlay.extends_until.getTime() > at.getTime();
}
