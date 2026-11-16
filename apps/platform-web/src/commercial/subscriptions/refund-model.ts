import type { RefundablePayment } from './subscriptions-api';
import { REFUND_REFUSAL_TEXT } from './subscriptions-model';

// Aramo-CCP-Console-Refund-Request-Directive-v1_0-LOCKED §2 item 2 — the PURE model of the console
// "Request refund" dialog. It decides nothing the server does not decide again: the remainder shown
// is the server's (the same rule runs at create, apply and dispatch, Amendment A1 RF-3..RF-5), and the
// payload is the server's closed REFUND key set (commercial-change-request.ts:654).

/** The refund categories of ARAMO-COM-REFUND-POL-001 v1.0 §5 (the server's REFUND_CATEGORIES). */
export const REFUND_CATEGORY_OPTIONS: ReadonlyArray<{
  readonly value: string;
  readonly label: string;
}> = [
  { value: 'R1_DUPLICATE', label: 'R1 · Duplicate payment' },
  { value: 'R2_OVERCHARGE', label: 'R2 · Incorrect billing amount' },
  { value: 'R3_UNAUTHORIZED', label: 'R3 · Unauthorized or disputed payment' },
  { value: 'R4_SERVICE_FAILURE', label: 'R4 · Verified service failure' },
  { value: 'R5_COMMITMENT_CANCELLATION', label: 'R5 · Cancellation during a commitment' },
  { value: 'R6_NONCOMMITTED_CANCELLATION', label: 'R6 · Cancellation without a commitment' },
  { value: 'R7_GOODWILL', label: 'R7 · Discretionary goodwill' },
  { value: 'R8_TAX', label: 'R8 · Taxes and regulatory adjustments' },
];

export const REFUND_BASIS_MAX = 2000;

/** "$10.00" / "₹999.00" / "EUR 5.00" — a minor-unit amount (two-decimal currencies only). */
export function moneyLabel(minor: number | null, currency: string | null): string {
  if (minor === null) return '—';
  const c = (currency ?? '').toUpperCase();
  const n = (minor / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (c === 'USD') return `$${n}`;
  if (c === 'INR') return `₹${n}`;
  return c ? `${c} ${n}` : n;
}

/** "12.50" → 1250; anything else (empty, negative, more than 2 decimals, not a number) → null. */
export function parseAmount(text: string): number | null {
  const t = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(minor) ? minor : null;
}

/** The amount field's text for a minor-unit amount ("10.00"). */
export function amountText(minor: number): string {
  return (minor / 100).toFixed(2);
}

/** Why a payment can't be picked (null = it can). */
export function paymentBlockedWhy(p: RefundablePayment): string | null {
  if (p.refusal !== null)
    return REFUND_REFUSAL_TEXT[p.refusal] ?? `Not refundable here (${p.refusal}).`;
  if (p.payment_ref === null || p.remainder_minor === null)
    return REFUND_REFUSAL_TEXT['REFUND_REMAINDER_UNVERIFIABLE'] ?? 'Not refundable here.';
  if (p.remainder_minor <= 0)
    return 'Already fully refunded or reserved by another refund request.';
  return null;
}

export interface RefundDraft {
  readonly payment: RefundablePayment | null;
  readonly amountText: string;
  readonly category: string;
  readonly basis: string;
}

/** The first problem with the draft, or null when it can be submitted. */
export function refundDraftError(d: RefundDraft): string | null {
  if (d.payment === null) return 'Choose a payment.';
  const blocked = paymentBlockedWhy(d.payment);
  if (blocked !== null) return blocked;
  const minor = parseAmount(d.amountText);
  if (minor === null || minor < 1) return 'Enter an amount of at least 0.01.';
  if (minor > (d.payment.remainder_minor ?? 0))
    return `The most that can be refunded is ${moneyLabel(d.payment.remainder_minor, d.payment.currency)}.`;
  if (!REFUND_CATEGORY_OPTIONS.some((c) => c.value === d.category))
    return 'Choose a refund category.';
  if (d.basis.trim().length === 0) return 'State the contractual or legal basis.';
  if (d.basis.length > REFUND_BASIS_MAX)
    return `The basis must be at most ${REFUND_BASIS_MAX} characters.`;
  return null;
}

/** The REFUND payload — exactly the server's closed key set. null while the draft is invalid. */
export function refundPayload(
  d: RefundDraft,
  policyRef: string,
  subscriptionId: string | null,
): Record<string, unknown> | null {
  if (
    refundDraftError(d) !== null ||
    d.payment === null ||
    d.payment.payment_ref === null ||
    d.payment.currency === null
  )
    return null;
  return {
    amount_minor: parseAmount(d.amountText),
    currency: d.payment.currency.toUpperCase(),
    provider_invoice_ref: d.payment.invoice_ref,
    provider_payment_ref: d.payment.payment_ref,
    category: d.category,
    basis: d.basis.trim(),
    refund_policy_ref: policyRef,
    ...(subscriptionId !== null ? { subscription_id: subscriptionId } : {}),
  };
}

/** The ACTIVE policy's refund reference when it enables refunds (A2 RX-6), else null. */
export function activeRefundPolicyRef(
  list: {
    versions: ReadonlyArray<{
      id: string;
      status: string;
      content: { refund_execution_enabled?: boolean; refund_policy_ref?: string } | null;
    }>;
    active_version_id: string | null;
  } | null,
): string | null {
  if (list === null) return null;
  const active = list.versions.find(
    (v) =>
      v.status === 'ACTIVE' && (list.active_version_id === null || v.id === list.active_version_id),
  );
  const c = active?.content ?? null;
  return c !== null &&
    c.refund_execution_enabled === true &&
    typeof c.refund_policy_ref === 'string' &&
    c.refund_policy_ref.length > 0
    ? c.refund_policy_ref
    : null;
}

