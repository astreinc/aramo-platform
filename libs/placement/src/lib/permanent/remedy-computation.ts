// Track 7 / T7-P2 — the guarantee-specific remedy obligation computation (directive
// §7 / §8). PURE: no I/O, no DB. Track-7-owned arithmetic — it does NOT call or extend
// deriveCommercialMetrics (a different, T9-shared formula, §7/§8). All money is
// Prisma.Decimal — NEVER binary floating-point — with explicit ROUND_HALF_UP to
// scale 2 (the currency minor unit). Calendar-day arithmetic in UTC (dates are
// @db.Date). The result is an OBLIGATION amount owed under the guarantee, never a
// money movement (§3.4 — Aramo executes nothing).

import { Prisma } from '../../../prisma/generated/client/client.js';
import { REMEDY_POLICY_TO_DUE_STATE, type RemedyDueState, type RemedyPolicy } from '../lifecycle/placement-lifecycle.js';

// Whole calendar days between two @db.Date instants (UTC midnight), end − start.
// Exact for date-only values; Math.round guards against any DST/rounding artefact.
export function calendarDaysBetween(startDate: Date, endDate: Date): number {
  const MS_PER_DAY = 86_400_000;
  return Math.round((endDate.getTime() - startDate.getTime()) / MS_PER_DAY);
}

export type RemedyObligation = {
  readonly remedy_type: RemedyPolicy;
  readonly due_state: RemedyDueState;
  // Money owed (scale-2 string) + currency, present for REFUND/PRORATED_CREDIT; null
  // for the non-monetary REPLACEMENT obligation.
  readonly calculated_amount: string | null;
  readonly currency: string | null;
  // Proration input (clamped), present only for PRORATED_CREDIT.
  readonly remaining_days: number | null;
};

// Compute the deterministic remedy obligation from the IMMUTABLE guarantee snapshot +
// the qualifying falloff date. remedy_policy MUST be one of the three governed values
// (the caller fails closed otherwise — PERMANENT_PLACEMENT_REMEDY_INVALID). Inputs are
// the persisted scale-2 exposure string, the currency, the positive duration, the
// guarantee end date, and the falloff effective date.
export function computeRemedyObligation(input: {
  remedy_policy: RemedyPolicy;
  exposure_amount: string;
  exposure_currency: string;
  guarantee_duration_days: number;
  guarantee_end_date: Date;
  falloff_effective_date: Date;
}): RemedyObligation {
  const due_state = REMEDY_POLICY_TO_DUE_STATE[input.remedy_policy];
  const exposure = new Prisma.Decimal(input.exposure_amount);

  if (input.remedy_policy === 'REPLACEMENT') {
    // A non-monetary obligation — no amount, no currency, no proration input.
    return { remedy_type: 'REPLACEMENT', due_state, calculated_amount: null, currency: null, remaining_days: null };
  }

  if (input.remedy_policy === 'REFUND') {
    // refund_amount = guarantee_exposure_amount (§7). Identity — no proration.
    return {
      remedy_type: 'REFUND',
      due_state,
      calculated_amount: exposure.toFixed(2, Prisma.Decimal.ROUND_HALF_UP),
      currency: input.exposure_currency,
      remaining_days: null,
    };
  }

  // PRORATED_CREDIT (§8):
  //   remaining_days = clamp(guarantee_end_date − falloff_effective_date, [0, duration])
  //   credit = exposure_amount × remaining_days / guarantee_duration_days
  // Half-up to scale 2. Never negative, never above exposure.
  const rawRemaining = calendarDaysBetween(input.falloff_effective_date, input.guarantee_end_date);
  const remaining_days = Math.max(0, Math.min(rawRemaining, input.guarantee_duration_days));

  const credit = exposure
    .times(new Prisma.Decimal(remaining_days))
    .div(new Prisma.Decimal(input.guarantee_duration_days));

  // Clamp defensively to [0, exposure] before rounding (the formula already yields this
  // for remaining_days in [0, duration], but the invariant is asserted, not assumed).
  const clamped = Prisma.Decimal.max(new Prisma.Decimal(0), Prisma.Decimal.min(credit, exposure));

  return {
    remedy_type: 'PRORATED_CREDIT',
    due_state,
    calculated_amount: clamped.toFixed(2, Prisma.Decimal.ROUND_HALF_UP),
    currency: input.exposure_currency,
    remaining_days,
  };
}
