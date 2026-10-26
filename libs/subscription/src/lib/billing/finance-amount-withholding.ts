// CCP-R3 item 1 — Aramo-CCP-A1-Amendment-A1-Finance-Amount-Scope-v1_0 (LOCKED 2026-10-25), FA-1,
// FA-4, FA-5, FA-6. A tenant-specific monetary figure needs `platform:billing:amount:read` IN
// ADDITION TO `platform:billing:read`; billing read alone never authorizes one (FA-1). Enforcement
// is backend field authorization (FA-5): for a caller without both scopes every monetary field is
// OMITTED (never sent for a UI to hide) and the object carries
//   amount_withheld: "FINANCE_SCOPE_REQUIRED".
// The interim FA-9 rule (withhold for everyone, FINANCE_SCOPE_PENDING) is superseded by this.
// Catalog list prices (a plan version's published price) are governed by catalog read authority
// (FA-3) and never pass through here.
//
// Pure: no I/O. Each function returns a copy; the input is never mutated.

export const BILLING_READ_SCOPE = 'platform:billing:read';
export const FINANCE_AMOUNT_SCOPE = 'platform:billing:amount:read';
export const FINANCE_AMOUNT_WITHHELD = 'FINANCE_SCOPE_REQUIRED' as const;
export type FinanceAmountWithheld = typeof FINANCE_AMOUNT_WITHHELD;

/** FA-1: true only when the caller holds BOTH platform:billing:read and platform:billing:amount:read. */
export function financeAmountAccess(scopes: readonly string[] | null | undefined): boolean {
  return scopes !== null && scopes !== undefined && scopes.includes(BILLING_READ_SCOPE) && scopes.includes(FINANCE_AMOUNT_SCOPE);
}

/**
 * The tenant-specific amount key a commercial change request, its chain basis and its audit trail
 * can carry: a CREDIT's `amount_minor` (FA-1 "credits and refunds applied to a tenant"). Policy
 * thresholds (`credit_escalation_threshold_minor`) and catalog prices (`list_price_minor`) are
 * different keys and are kept.
 */
export const TENANT_AMOUNT_KEYS: readonly string[] = ['amount_minor'];

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function strip(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(strip);
  if (isRecord(v)) return stripRecord(v);
  return v;
}

function stripRecord(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let withheld = false;
  for (const [k, v] of Object.entries(obj)) {
    if (TENANT_AMOUNT_KEYS.includes(k)) {
      withheld = true;
      continue;
    }
    out[k] = strip(v);
  }
  if (withheld) out['amount_withheld'] = FINANCE_AMOUNT_WITHHELD;
  return out;
}

/**
 * FA-5: with access, a copy unchanged. Without it, every TENANT_AMOUNT_KEYS field is removed
 * (recursively) and each object that lost one gains `amount_withheld: "FINANCE_SCOPE_REQUIRED"`.
 */
export function withholdTenantAmounts(obj: Record<string, unknown>, access: boolean): Record<string, unknown> {
  return access ? (structuredClone(obj) as Record<string, unknown>) : stripRecord(obj);
}

/**
 * CCP-R3 (Lead, TD-C4-7) — the change-request action types whose payload carries a tenant-specific
 * monetary figure. REFUND does not exist in this base (CCP-C4 adds it); it is listed so the one
 * redaction below covers it on merge. DISCOUNT carries `discount_bps`: a percentage is NOT a tenant
 * amount (D-R3-7), so a DISCOUNT payload keeps it; any amount key it might carry is still withheld.
 */
export const MONETARY_ACTION_TYPES: readonly string[] = ['CREDIT', 'DISCOUNT', 'REFUND'];
/** Policy thresholds and catalog prices are not tenant amounts (FA-3) even inside a monetary payload. */
const NON_TENANT_AMOUNT_KEYS: readonly string[] = ['credit_escalation_threshold_minor', 'discount_escalation_threshold_bps', 'list_price_minor', 'reference_price_minor'];
const isMonetaryKey = (k: string): boolean => !NON_TENANT_AMOUNT_KEYS.includes(k) && (TENANT_AMOUNT_KEYS.includes(k) || k.endsWith('_minor') || /^amount(_|$)/.test(k));

function stripMonetary(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripMonetary);
  if (!isRecord(v)) return v;
  const out: Record<string, unknown> = {};
  let withheld = false;
  for (const [k, x] of Object.entries(v)) {
    if (isMonetaryKey(k)) {
      withheld = true;
      continue;
    }
    out[k] = stripMonetary(x);
  }
  if (withheld) out['amount_withheld'] = FINANCE_AMOUNT_WITHHELD;
  return out;
}

/**
 * THE shared redaction of a change request's payload / chain basis, and of a commercial audit
 * event body (keyed on its `action_type`), for the A3 reads, the A2 audit read and the B5 export.
 * With access: a deep copy. Without: for a monetary action type every amount-like key
 * (`amount_minor`, any `*_minor`, `amount*`; policy thresholds and catalog prices excepted) is
 * omitted, recursively, with `amount_withheld: "FINANCE_SCOPE_REQUIRED"`; for any other action the
 * `amount_minor` key is still withheld (fail closed).
 */
export function withholdChangeRequestAmounts(action_type: string | null | undefined, obj: Record<string, unknown>, access: boolean): Record<string, unknown> {
  if (access) return structuredClone(obj) as Record<string, unknown>;
  if (typeof action_type === 'string' && MONETARY_ACTION_TYPES.includes(action_type)) return stripMonetary(obj) as Record<string, unknown>;
  return stripRecord(obj);
}

/**
 * Merge train (TD-MERGE-43, CCP-C4 × R3) — a provider command's params (a C4 billing-adjustment
 * command carries the CREDIT / REFUND amount it sends). Every amount-like key is withheld without
 * access, whatever the command kind (fail closed; cancel / expire params carry none).
 */
export function withholdMonetaryAmounts(obj: Record<string, unknown>, access: boolean): Record<string, unknown> {
  return access ? (structuredClone(obj) as Record<string, unknown>) : (stripMonetary(obj) as Record<string, unknown>);
}

/** An audit event body: the action type it names (A3 events carry `action_type`). */
export function withholdAuditPayloadAmounts(payload: Record<string, unknown>, access: boolean): Record<string, unknown> {
  const action = typeof payload['action_type'] === 'string' ? payload['action_type'] : null;
  return withholdChangeRequestAmounts(action, payload, access);
}

/** The C3 invoice amount fields (Stripe-owned figures for one tenant). */
export const INVOICE_AMOUNT_FIELDS = ['total_minor', 'amount_due_minor', 'amount_paid_minor', 'amount_remaining_minor'] as const;
/** The provider-hosted invoice page and PDF display the amounts, so they are withheld with them. */
export const INVOICE_AMOUNT_LINK_FIELDS = ['hosted_url', 'document_url'] as const;

/** FA-4 — the payment states that mean an amount is owed now, and the one that means it is late. */
export const PAYMENT_DUE_STATES: readonly string[] = ['DUE', 'OVERDUE', 'PAYMENT_FAILED'];
export const PAYMENT_OVERDUE_STATES: readonly string[] = ['OVERDUE'];

/**
 * FA-4 (FAS-3) — the narrowly derived booleans every platform:billing:read holder may read
 * (support_admin included). Two booleans, nothing else: no balance, currency, item, line or count.
 */
export function paymentFlags(payment_states: readonly string[]): { payment_due: boolean; payment_overdue: boolean } {
  return {
    payment_due: payment_states.some((s) => PAYMENT_DUE_STATES.includes(s)),
    payment_overdue: payment_states.some((s) => PAYMENT_OVERDUE_STATES.includes(s)),
  };
}
