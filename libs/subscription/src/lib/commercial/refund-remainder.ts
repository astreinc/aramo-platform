import type { ProviderPaymentPicture } from '../billing/billing-provider.port.js';

// CCP-C4-P (Aramo-CCP-Program-Build-Directive-Amendment-A1-Commercial-Action-Catalog-v1_0-LOCKED §3
// RF-3, RF-4, RF-5, RF-9) — the PURE refundable-remainder rule. No I/O and no clock.
//
// remainder = the verified captured amount of the payment
//           − the refunds confirmed at the provider (succeeded)
//           − the refunds pending at the provider (pending, requires_action)
//           − the funds lost to a dispute (status lost)
//           − every OUTSTANDING Aramo REFUND reservation on the same payment (APPROVED, APPLYING,
//             APPLY_FAILED; a held uncertain command included), counted ONCE: a reservation whose
//             command is already visible at the provider (matched by the command id in the refund's
//             metadata, or by its recorded refund object) is counted through that provider refund,
//             at the larger of the two amounts, never twice.
// An uncertain outcome never makes the same amount refundable again (its reservation stays).
// Refused, never guessed:
//   REFUND_PAYMENT_DISPUTED        a dispute on the payment is open or unresolved
//   REFUND_REMAINDER_UNVERIFIABLE  the picture is incomplete, carries an unknown refund / dispute
//                                  status, a refund with no identity, or no payment
//   REFUND_PAYMENT_MISMATCH        the payment / paying account is not the one the request binds (RF-5)
//   REFUND_CURRENCY_MISMATCH       the request currency is not the payment currency (RF-5)
//   REFUND_EXCEEDS_REMAINDER       the amount is larger than the remainder (RF-3)

export const REFUND_REMAINDER_REFUSALS = [
  'REFUND_PAYMENT_DISPUTED',
  'REFUND_REMAINDER_UNVERIFIABLE',
  'REFUND_PAYMENT_MISMATCH',
  'REFUND_CURRENCY_MISMATCH',
  'REFUND_EXCEEDS_REMAINDER',
] as const;
export type RefundRemainderRefusal = (typeof REFUND_REMAINDER_REFUSALS)[number];

/** Provider refund statuses: the ones that hold funds, and the ones that no longer can. */
const REFUND_HOLDING = ['succeeded', 'pending', 'requires_action'];
const REFUND_RELEASED = ['failed', 'canceled'];
/** Stripe dispute statuses: open (refunds blocked), lost (funds reversed), closed without loss. */
const DISPUTE_OPEN = ['warning_needs_response', 'warning_under_review', 'needs_response', 'under_review'];
const DISPUTE_LOST = ['lost'];
const DISPUTE_CLOSED = ['won', 'warning_closed'];

/** One outstanding local REFUND reservation on the same payment (another request, or this one's own command). */
export interface LocalRefundReservation {
  change_request_id: string;
  amount_minor: number;
  /** The command ids of the request (empty before apply). */
  command_ids: readonly string[];
  /** The refund objects its commands recorded. */
  provider_object_refs: readonly string[];
}

export interface RefundRemainderInput {
  picture: ProviderPaymentPicture;
  /** What the request binds (RF-5). */
  expected: { account_ref: string; payment_ref: string; currency: string };
  outstanding: readonly LocalRefundReservation[];
}

export type RefundRemainderResult =
  | {
      ok: true;
      captured_minor: number;
      provider_held_minor: number;
      disputed_lost_minor: number;
      local_reserved_minor: number;
      remainder_minor: number;
    }
  | { ok: false; refusal: RefundRemainderRefusal; detail: Record<string, unknown> };

export function refundableRemainder(input: RefundRemainderInput): RefundRemainderResult {
  const { picture: p, expected: e } = input;
  const no = (refusal: RefundRemainderRefusal, detail: Record<string, unknown> = {}): RefundRemainderResult => ({ ok: false, refusal, detail });
  if (!p.complete) return no('REFUND_REMAINDER_UNVERIFIABLE', { basis: 'provider_list_truncated' });
  if (p.payment_ref === null) return no('REFUND_REMAINDER_UNVERIFIABLE', { basis: 'no_payment' });
  if (p.payment_ref !== e.payment_ref || p.account_ref !== e.account_ref) return no('REFUND_PAYMENT_MISMATCH', { basis: p.payment_ref !== e.payment_ref ? 'payment' : 'paying_account' });
  if (p.currency === null || p.currency.toUpperCase() !== e.currency.toUpperCase()) return no('REFUND_CURRENCY_MISMATCH', { payment_currency: p.currency });
  if (!Number.isSafeInteger(p.captured_minor) || p.captured_minor < 0) return no('REFUND_REMAINDER_UNVERIFIABLE', { basis: 'captured_amount' });
  let disputed_lost_minor = 0;
  for (const d of p.disputes) {
    const s = d.status ?? '';
    if (DISPUTE_OPEN.includes(s)) return no('REFUND_PAYMENT_DISPUTED', { dispute_status: s });
    if (DISPUTE_LOST.includes(s)) disputed_lost_minor += d.amount_minor;
    else if (!DISPUTE_CLOSED.includes(s)) return no('REFUND_REMAINDER_UNVERIFIABLE', { basis: 'dispute_status', dispute_status: d.status });
  }
  // Provider refunds that hold funds, keyed for matching.
  const holding: Array<{ object_ref: string | null; command_id: string | null; amount_minor: number }> = [];
  for (const r of p.refunds) {
    const s = r.status ?? '';
    if (REFUND_HOLDING.includes(s)) holding.push(r);
    else if (!REFUND_RELEASED.includes(s)) return no('REFUND_REMAINDER_UNVERIFIABLE', { basis: 'refund_status', refund_status: r.status });
  }
  let provider_held_minor = 0;
  const matched = new Set<number>();
  let local_reserved_minor = 0;
  for (const l of input.outstanding) {
    // A reservation visible at the provider is counted ONCE, at the larger amount.
    const i = holding.findIndex((h, k) => !matched.has(k) && ((h.command_id !== null && l.command_ids.includes(h.command_id)) || (h.object_ref !== null && l.provider_object_refs.includes(h.object_ref))));
    if (i >= 0) {
      matched.add(i);
      local_reserved_minor += Math.max(l.amount_minor, holding[i]!.amount_minor);
    } else {
      local_reserved_minor += l.amount_minor;
    }
  }
  holding.forEach((h, k) => {
    if (!matched.has(k)) provider_held_minor += h.amount_minor;
  });
  const remainder_minor = p.captured_minor - provider_held_minor - disputed_lost_minor - local_reserved_minor;
  return { ok: true, captured_minor: p.captured_minor, provider_held_minor, disputed_lost_minor, local_reserved_minor, remainder_minor: Math.max(remainder_minor, 0) };
}

/** The decision for one refund amount (RF-3: positive and ≤ the remainder). */
export function assessRefundAmount(input: RefundRemainderInput, amount_minor: number): RefundRemainderResult {
  const r = refundableRemainder(input);
  if (!r.ok) return r;
  if (amount_minor > r.remainder_minor) return { ok: false, refusal: 'REFUND_EXCEEDS_REMAINDER', detail: { remainder_known: true } };
  return r;
}
