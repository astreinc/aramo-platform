import type { AdjustmentCommandKind } from '../billing/billing-provider-command.js';
import type { ProviderAdjustmentEffect } from '../billing/billing-provider.port.js';

import type { C4BillingAdjustmentAction } from './commercial-change-request.js';

// CCP-C4 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.2 row C4, §10; Conversion Rule C-22,
// C-23) — the PURE half of the billing adjustments: the payload reading, the operation and its C1
// command (kind, step, params), the refund designed disabled state, and the Finance amount interim.
// No I/O and no clock.
//
// Delivery status: NOT DELIVERED until the refund policy (legal) is verified (PBD §10). Credits and
// discounts run end to end in Stripe TEST mode (the C1 dispatcher refuses a live key, TD-C1-3);
// REFUND is built and DISABLED by design (REFUND_POLICY_NOT_APPROVED) unless the explicit flag
// CCP_REFUND_EXECUTION_ENABLED=1 is set (default off; set only in tests; not in any compose or
// .env example).

/** The operation one billing-adjustment request performs at the provider. */
export type BillingAdjustmentOperation = AdjustmentCommandKind;

/** The C1 command step of each operation (the idempotency key is derived from request + step, C-22). */
export const ADJUSTMENT_STEP: Readonly<Record<BillingAdjustmentOperation, string>> = {
  CREDIT_GRANT: 'credit_grant',
  CREDIT_REVERSE: 'credit_reverse',
  DISCOUNT_APPLY: 'discount_apply',
  DISCOUNT_REMOVE: 'discount_remove',
  REFUND_CREATE: 'refund_create',
};

/** The refund designed disabled state (PBD §10): the stable refusal code. */
export const REFUND_POLICY_NOT_APPROVED = 'REFUND_POLICY_NOT_APPROVED';
/** The explicit opt-in flag (default OFF). Only `1` enables the refund execution path. */
export const REFUND_EXECUTION_FLAG = 'CCP_REFUND_EXECUTION_ENABLED';
export function refundExecutionEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[REFUND_EXECUTION_FLAG] === '1';
}

/**
 * The deterministic provider coupon id of the discount applied by `change_request_id` (one per
 * request; a retried dispatch can never create a second coupon). The compensation removes it.
 */
export function discountCouponRef(change_request_id: string): string {
  return `aramo-ccp-${change_request_id}-${ADJUSTMENT_STEP.DISCOUNT_APPLY}`;
}

export interface CreditPayload {
  amount_minor: number;
  currency: string;
  subscription_id?: string;
  compensates_change_request_id?: string;
}
export interface DiscountPayload {
  discount_bps: number;
  subscription_id?: string;
  compensates_change_request_id?: string;
}
export interface RefundPayload {
  amount_minor: number;
  currency: string;
  provider_invoice_ref: string;
  subscription_id?: string;
}
export type BillingAdjustmentPayload = CreditPayload | DiscountPayload | RefundPayload;

/** The operation of an (already validated) payload. A compensation reverses its original. */
export function adjustmentOperationOf(action_type: C4BillingAdjustmentAction, payload: Record<string, unknown>): BillingAdjustmentOperation {
  const compensates = typeof payload['compensates_change_request_id'] === 'string';
  switch (action_type) {
    case 'CREDIT':
      return compensates ? 'CREDIT_REVERSE' : 'CREDIT_GRANT';
    case 'DISCOUNT':
      return compensates ? 'DISCOUNT_REMOVE' : 'DISCOUNT_APPLY';
    case 'REFUND':
      return 'REFUND_CREATE';
  }
}

// ---- refusals and failures ------------------------------------------------------------------

/** Refusals (nothing changes; one APPLY_REFUSED audit row). */
export type BillingAdjustmentRefusalCode = typeof REFUND_POLICY_NOT_APPROVED | 'APPLY_EXPIRED' | typeof REFUND_OUTCOME_UNCERTAIN | 'NOT_RESOLVABLE';

// ---- CCP-C4-R: REFUND identity (Architect C4 disposition, TD-C4-1 / TD-C4-12) -----------------
//
// A REFUND names the provider invoice whose payment it refunds (`provider_invoice_ref`; the invoice
// carries exactly one payment) and an amount (≥ 1 minor unit, ≤ the payment's refundable remainder,
// checked against the provider before any write: a PARTIAL refund is allowed, pending the catalog
// amendment's decision point 2). Its provider references: the invoice (target), the paying account,
// the payment, and the refund object. Its own audit events and reconciliation outcomes below.

/** The REFUND-specific audit event names (the other C4 types keep the COMMERCIAL_BILLING_ADJUSTMENT_* names). */
export const REFUND_AUDIT_EVENTS = {
  PENDING_PROVIDER: 'COMMERCIAL_REFUND_PENDING_PROVIDER',
  CONFIRMED: 'COMMERCIAL_REFUND_CONFIRMED',
  REARMED: 'COMMERCIAL_REFUND_REARMED',
  RESOLVED_NOT_EXECUTED: 'COMMERCIAL_REFUND_RESOLVED_NOT_EXECUTED',
} as const;
export function adjustmentAuditEvent(action_type: string, step: 'PENDING_PROVIDER' | 'CONFIRMED' | 'REARMED'): string {
  return action_type === 'REFUND' ? REFUND_AUDIT_EVENTS[step] : `COMMERCIAL_BILLING_ADJUSTMENT_${step}`;
}

/**
 * The reconciliation outcome of one refund command, from an AUTHORITATIVE provider read:
 *   CONFIRMED           the refund of this command succeeded for exactly the approved amount
 *   PENDING             it exists and may still complete (pending / requires_action)
 *   PARTIAL             it exists for another amount than approved (never recorded APPLIED; held)
 *   FAILED_AT_PROVIDER  it exists and can no longer complete (failed / canceled)
 *   NOT_FOUND           no refund exists for this command at the provider
 * Only NOT_FOUND and FAILED_AT_PROVIDER prove that no refund can still complete.
 */
export type RefundReconciliationOutcome = 'CONFIRMED' | 'PENDING' | 'PARTIAL' | 'FAILED_AT_PROVIDER' | 'NOT_FOUND';
export function refundReconciliationOutcome(effect: Pick<ProviderAdjustmentEffect, 'object_ref' | 'provider_status' | 'observed_amount_minor'>, approved_amount_minor: number): RefundReconciliationOutcome {
  if (effect.object_ref === null) return 'NOT_FOUND';
  if (effect.provider_status === 'failed' || effect.provider_status === 'canceled') return 'FAILED_AT_PROVIDER';
  if (effect.observed_amount_minor !== approved_amount_minor) return 'PARTIAL';
  return effect.provider_status === 'succeeded' ? 'CONFIRMED' : 'PENDING';
}
export function refundCannotComplete(o: RefundReconciliationOutcome): boolean {
  return o === 'NOT_FOUND' || o === 'FAILED_AT_PROVIDER';
}

/** The outcome is not proven (a provider read failed, a refund is pending or mismatched, a dispatch is in flight). */
export const REFUND_OUTCOME_UNCERTAIN = 'REFUND_OUTCOME_UNCERTAIN';

export class BillingAdjustmentRefusedError extends Error {
  constructor(
    readonly reason: BillingAdjustmentRefusalCode,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(`billing adjustment apply refused (${reason})`);
    this.name = 'BillingAdjustmentRefusedError';
  }
}

/** Failures of a check taken before any command exists (rolled back; recorded APPLY_FAILED). */
export type BillingAdjustmentFailureCode =
  | 'TARGET_NOT_FOUND'
  | 'TARGET_STALE'
  | 'TARGET_NOT_SELF_SERVICE'
  | 'COMPENSATION_TARGET_INVALID'
  | 'COMPENSATION_MISMATCH'
  | 'ALREADY_COMPENSATED'
  | 'INVALID_PAYLOAD'
  | 'UNEXPECTED';

export class BillingAdjustmentFailure extends Error {
  constructor(
    readonly code: BillingAdjustmentFailureCode,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(`billing adjustment failed (${code})`);
    this.name = 'BillingAdjustmentFailure';
  }
}

// ---- Finance amount interim (decisions TD-C3-5 ruling; draft FA-6 marker) ---------------------

/**
 * Until the Finance amount scope is LOCKED, every tenant-specific amount is withheld for ALL
 * callers of a C4 route (FA-6 interim marker). A percentage is not an amount and stays visible.
 */
export const AMOUNT_WITHHELD_MARKER = 'FINANCE_SCOPE_PENDING' as const;
const AMOUNT_KEYS = ['amount_minor', 'credit_escalation_threshold_minor'] as const;

/** A shallow copy without any amount key, marked `amount_withheld` when one was removed. */
export function withholdAmounts<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let withheld = false;
  for (const [k, v] of Object.entries(obj)) {
    if ((AMOUNT_KEYS as readonly string[]).includes(k)) withheld = true;
    else out[k] = v;
  }
  if (withheld) out['amount_withheld'] = AMOUNT_WITHHELD_MARKER;
  return out;
}
