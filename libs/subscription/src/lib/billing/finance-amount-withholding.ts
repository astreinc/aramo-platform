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

import { BILLING_COMMAND_KINDS_BY_ACTION } from './billing-provider-command.js';

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

/**
 * An audit event body: the action type it names (A3 events carry `action_type`).
 * CCP-R3-W extends it (one audit redaction for the A2 feed and the B5 CSV export): without access
 * it also withholds contract terms (W-2), a financial action's free text (W-3: `reason`, `comment`;
 * the audit stream has no requester exception, fail closed) and provider error text (item 3).
 */
export function withholdAuditPayloadAmounts(payload: Record<string, unknown>, access: boolean): Record<string, unknown> {
  const action = typeof payload['action_type'] === 'string' ? payload['action_type'] : null;
  const amounts = withholdChangeRequestAmounts(action, payload, access);
  if (access) return amounts;
  let out = withholdContractTermsDeep(amounts, false) as Record<string, unknown>;
  out = withholdProviderText(out, false);
  if (isFinancialRequestAction(action)) {
    const text: Record<string, unknown> = {};
    let reason = false;
    let notes = false;
    for (const [k, v] of Object.entries(out)) {
      if (k === 'reason') reason = true;
      else if (FINANCIAL_NOTE_KEYS.includes(k)) notes = true;
      else text[k] = v;
    }
    if (reason) text['reason_withheld'] = FINANCE_AMOUNT_WITHHELD;
    if (notes) text['notes_withheld'] = FINANCE_AMOUNT_WITHHELD;
    out = text;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// CCP-R3-W — Architect rulings W-2 / W-3 (CCP-UI v1.2 Finance visibility, 2026-10-25) and the
// integrator's C4 refusal-detail residual (TD-MERGE-43). Same rule, same marker, same projection
// boundary as FA-5: for a caller without platform:billing:read AND platform:billing:amount:read
// the field is OMITTED (never sent for a UI to hide) and the object that lost it carries a marker:
//   terms_withheld | reason_withheld | evidence_withheld | notes_withheld | detail_withheld
//     = "FINANCE_SCOPE_REQUIRED".
// Stored rows are never changed. Pure: no I/O; every function returns a copy.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** W-2 — the free-text negotiated-terms keys of a Contract / ContractAmendment projection. */
export const CONTRACT_TERMS_KEYS: readonly string[] = ['terms', 'recorded_terms'];
/** W-2 — the change-request payload blocks that carry contract terms (CCP-B4 `contract`, `contract_amendment`). */
export const CONTRACT_TERMS_BLOCK_KEYS: readonly string[] = ['contract', 'contract_amendment'];

/**
 * W-2 — one contract (or amendment) projection. Without access every CONTRACT_TERMS_KEYS key is
 * omitted and the object ALWAYS carries `terms_withheld` (also when the stored terms are absent or
 * null, so a reader cannot tell an unchanged amendment from a changed one).
 */
export function withholdContractTerms<T extends Record<string, unknown>>(obj: T, access: boolean): Record<string, unknown> {
  if (access) return structuredClone(obj) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (!CONTRACT_TERMS_KEYS.includes(k)) out[k] = structuredClone(v);
  out['terms_withheld'] = FINANCE_AMOUNT_WITHHELD;
  return out;
}

/**
 * W-2 — a change-request payload (or audit body): every object held under a CONTRACT_TERMS_BLOCK_KEYS
 * key, at any depth, loses its `terms` and carries `terms_withheld`. Keyed on the block, so a plan's
 * allowance `terms` (e.g. a USAGE_TREATMENT_UNDEFINED detail) is not a contract term and is kept.
 */
export function withholdContractTermsDeep(v: unknown, access: boolean): unknown {
  if (access) return structuredClone(v);
  if (Array.isArray(v)) return v.map((x) => withholdContractTermsDeep(x, false));
  if (!isRecord(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    out[k] = CONTRACT_TERMS_BLOCK_KEYS.includes(k) && isRecord(x) ? withholdContractTerms(withholdContractTermsDeep(x, false) as Record<string, unknown>, false) : withholdContractTermsDeep(x, false);
  }
  return out;
}

/**
 * W-3 — the change-request action types whose requester-entered text is Finance-scoped. Keyed on a
 * list: PAYMENT_RECORD does not exist in this base; it is listed so the projection covers it the
 * day it lands. Every other action type is never masked (W-3 "non-financial request reasons:
 * never redacted globally").
 */
export const FINANCIAL_REQUEST_ACTION_TYPES: readonly string[] = ['CREDIT', 'DISCOUNT', 'REFUND', 'PAYMENT_RECORD'];
export const isFinancialRequestAction = (a: string | null | undefined): boolean => typeof a === 'string' && FINANCIAL_REQUEST_ACTION_TYPES.includes(a);

/**
 * W-3 — the payload evidence keys of a financial request: the CCP-C4-P REFUND provenance (RF-2:
 * `category`, `basis`, `refund_policy_ref`). Requester-authored, set ONLY at create (the payload is
 * immutable: guard_commercial_change_request, `20261027000000_ccp_guard_union`). CREDIT and DISCOUNT
 * payloads carry none (closed key sets). Provider object ids (`provider_invoice_ref`,
 * `provider_payment_ref`) are identity references, not evidence, and stay (as R3 / TD-MERGE-43).
 */
export const FINANCIAL_EVIDENCE_KEYS: readonly string[] = ['category', 'basis', 'refund_policy_ref'];
/**
 * W-3 — the notes on a financial request: text added AFTER create by someone other than the
 * requester (the rejecter's `rejection_reason` on the request row; an approver's `comment`, which
 * lives in CommercialApproval rows, append-only). Always withheld from a non-holder, requester or not.
 */
export const FINANCIAL_NOTE_KEYS: readonly string[] = ['rejection_reason', 'comment'];

/**
 * Item 3 (TD-MERGE-43 residual) — provider-derived free text carried in a refusal / failure detail
 * (`REFUND_REMAINDER_UNVERIFIABLE` basis provider_read_failed `error`; an UNEXPECTED apply failure's
 * `error`; a C4 command's `last_error_detail`). Provider read errors are not expected to quote
 * amounts, but nothing guarantees it, so a non-holder never receives them.
 */
export const PROVIDER_TEXT_KEYS: readonly string[] = ['error', 'message', 'last_error', 'last_error_detail', 'last_detail'];

/** Item 3 — recursively omits PROVIDER_TEXT_KEYS; each object that lost one carries `detail_withheld`. */
export function withholdProviderText(obj: Record<string, unknown>, access: boolean): Record<string, unknown> {
  if (access) return structuredClone(obj) as Record<string, unknown>;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isRecord(v)) return v;
    const out: Record<string, unknown> = {};
    let withheld = false;
    for (const [k, x] of Object.entries(v)) {
      if (PROVIDER_TEXT_KEYS.includes(k)) {
        withheld = true;
        continue;
      }
      out[k] = walk(x);
    }
    if (withheld) out['detail_withheld'] = FINANCE_AMOUNT_WITHHELD;
    return out;
  };
  return walk(obj) as Record<string, unknown>;
}

/** W-3 — who is reading: the Finance amount decision and the caller's own user id (requester check). */
export interface FinanceReader {
  readonly amount_access: boolean;
  /** The server-resolved principal (`auth.sub`); null for a non-user caller (never the requester). */
  readonly user_id: string | null;
}

/** The fields of a change request the shared projection reads (a CommercialChangeRequestRow fits). */
export interface ChangeRequestProjectionInput {
  action_type: string;
  requested_by: string;
  reason: string;
  rejection_reason: string | null;
  payload: unknown;
  required_chain: unknown;
}

/** The finance-scoped fields of one change request projection (spread into the request DTO). */
export interface ChangeRequestFinanceProjection {
  payload: Record<string, unknown>;
  basis: Record<string, unknown>;
  reason?: string;
  reason_withheld?: FinanceAmountWithheld;
  rejection_reason?: string | null;
  notes_withheld?: FinanceAmountWithheld;
}

/**
 * THE change-request projection (R3 amounts + R3-W W-2 / W-3), used by every serializer of a
 * change request (requestDto in platform-admin; the C4 / A6 / A8 / C2 routes reuse it):
 *   - amounts: R3's withholdChangeRequestAmounts on the payload and the chain basis (unchanged);
 *   - W-2: every `contract` / `contract_amendment` block in the payload loses `terms` (any action);
 *   - W-3, financial action only, non-holder only:
 *       requester (requested_by == reader.user_id): `reason` and payload evidence kept (their own,
 *         immutable at create); `rejection_reason` omitted + `notes_withheld`;
 *       anyone else: `reason` omitted + `reason_withheld`; evidence omitted + `evidence_withheld`
 *         (on the payload); `rejection_reason` omitted + `notes_withheld`.
 *   - every other action type: reason and rejection_reason as stored.
 */
export function projectChangeRequestFinance(r: ChangeRequestProjectionInput, reader: FinanceReader): ChangeRequestFinanceProjection {
  const access = reader.amount_access;
  const chain = (isRecord(r.required_chain) ? r.required_chain : {}) as Record<string, unknown>;
  const basis = withholdChangeRequestAmounts(r.action_type, (isRecord(chain['basis']) ? chain['basis'] : {}) as Record<string, unknown>, access);
  let payload = withholdChangeRequestAmounts(r.action_type, (isRecord(r.payload) ? r.payload : {}) as Record<string, unknown>, access);
  payload = withholdContractTermsDeep(payload, access) as Record<string, unknown>;
  if (access || !isFinancialRequestAction(r.action_type)) return { payload, basis, reason: r.reason, rejection_reason: r.rejection_reason };
  const requester = reader.user_id !== null && reader.user_id === r.requested_by;
  if (!requester) payload = withholdEvidence(payload);
  return {
    payload,
    basis,
    ...(requester ? { reason: r.reason } : { reason_withheld: FINANCE_AMOUNT_WITHHELD }),
    notes_withheld: FINANCE_AMOUNT_WITHHELD,
  };
}

/** W-3 — a financial payload without its evidence keys; marked `evidence_withheld` when one was present. */
export function withholdEvidence(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let withheld = false;
  for (const [k, v] of Object.entries(payload)) {
    if (FINANCIAL_EVIDENCE_KEYS.includes(k)) {
      withheld = true;
      continue;
    }
    out[k] = structuredClone(v);
  }
  if (withheld) out['evidence_withheld'] = FINANCE_AMOUNT_WITHHELD;
  return out;
}

/**
 * W-3 — an approval of a financial request: a non-holder (the requester included) never receives
 * the approver's `comment`; the approval carries `notes_withheld` instead. Other action types: as stored.
 */
export function projectApprovalNotes<T extends { comment: string | null }>(action_type: string, a: T, reader: FinanceReader): Omit<T, 'comment'> & { comment?: string | null; notes_withheld?: FinanceAmountWithheld } {
  if (reader.amount_access || !isFinancialRequestAction(action_type)) return { ...a };
  const rest = Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'comment')) as Omit<T, 'comment'>;
  return { ...rest, notes_withheld: FINANCE_AMOUNT_WITHHELD };
}

/**
 * W-3 — a row of a report over financial requests that carries payload evidence (the C4-P refund
 * report's `category`): kept for a holder and for the row's own requester; otherwise omitted with
 * `evidence_withheld`.
 */
export function evidenceVisible(requested_by: string, reader: FinanceReader): boolean {
  return reader.amount_access || (reader.user_id !== null && reader.user_id === requested_by);
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

/**
 * Item 3 — the provider command kinds issued by a financial request (BILLING_COMMAND_KINDS_BY_ACTION
 * of CREDIT / DISCOUNT / REFUND; PAYMENT_RECORD has none yet). Their `last_error_detail` is
 * provider-derived text about a tenant-specific adjustment.
 */
export function isFinancialCommandKind(kind: string): boolean {
  return FINANCIAL_REQUEST_ACTION_TYPES.some((a) => (BILLING_COMMAND_KINDS_BY_ACTION[a] ?? []).includes(kind as never));
}
