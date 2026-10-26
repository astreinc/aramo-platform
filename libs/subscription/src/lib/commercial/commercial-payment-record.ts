import { Inject, Injectable, Optional } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from '../prisma/prisma.service.js';

import { type RosterEntry, checkChainSatisfiable } from './commercial-approval-eligibility.js';
import { type CommercialRequiredChain, chainOf } from './commercial-change-request.js';
import {
  INITIAL_OBLIGATION_REF,
  type ObligationPaymentStatus,
  type PaymentEvidence,
  type PaymentObligationTerm,
  type PaymentRecordPayload,
  type PaymentTarget,
  type PaymentTermsBlock,
  calendarDateIn,
  initialObligationOf,
  obligationPaymentStatus,
  paymentStatusFlags,
} from './commercial-payment-terms.js';

// CCP-C8-PR (Aramo-CCP-Program-Build-Directive-Amendment-A2-Payment-Record-v1_0-LOCKED) — PAYMENT_RECORD:
// the create-time chain (PR-3), the in-transaction checks of the evidence (PR-5, PR-6, PR-8, PR-9, §4.2),
// the receipt write of the apply (PR-4), the PREPAID activation gate and link of the SUBSCRIPTION_OPEN
// apply (PR-7, §4.3), and the derived payment status read (PR-10, PR-11).
//
// Boundaries (§1, PR-7, PR-9, PR-10): recording a payment never opens a subscription, never changes an
// obligation, never forgives, credits or overrides eligibility, never writes TenantSubscription, and calls
// no external provider. Every write here runs inside the caller's transaction, which holds the tenant's
// billing lock (the A6 apply, or the change-request create).

type Tx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];
type Reader = Pick<PrismaService, '$queryRawUnsafe'>;

export const PAYMENT_RECORD_SCOPE = 'platform:payment:request';

// ---- PR-3 chain (resolved ONCE at creation, snapshotted) -----------------------------------------

/**
 * PR-3, inside the create transaction, from the requester's LIVE roles and the live roster:
 *   CORRECT (any requester)          → Finance → Owner
 *   RECORD by commercial_ops         → Finance (FINANCE_ONLY: one distinct finance_admin)
 *   RECORD by finance_admin          → Finance filled by a DIFFERENT finance_admin, unless the A9 chain
 *                                      fulfillability check finds none at creation: then the Platform
 *                                      Owner exception (rule DISTINCT_PLATFORM_OWNER, `exception: true`
 *                                      and its basis in the snapshot). Never chosen afterwards.
 * A requester holding the scope but neither role has no defined chain (null: refused, fail closed).
 * The requester never fills any step (SELF_APPROVAL, D8).
 */
export function resolvePaymentRecordChain(
  payload: Record<string, unknown>,
  requester: { user_id: string; role_keys: readonly string[] },
  roster: readonly RosterEntry[],
  evaluated_at: Date,
): CommercialRequiredChain | null {
  if (payload['operation'] === 'CORRECT') {
    return chainOf('FINANCE_THEN_OWNER', 'billing', { ruling: 'PR-3 payment correction (Finance then Owner)', operation: 'CORRECT' });
  }
  const finance = requester.role_keys.includes('finance_admin');
  if (!finance && !requester.role_keys.includes('commercial_ops')) return null;
  if (!finance) return chainOf('FINANCE_ONLY', 'billing', { ruling: 'PR-3 commercial_ops requester (Finance)', operation: 'RECORD', requester_role: 'commercial_ops' });
  const financeChain = chainOf('FINANCE_ONLY', 'billing', {});
  const gate = checkChainSatisfiable(financeChain.steps, roster, new Set([requester.user_id]));
  if (gate.satisfiable) {
    return chainOf('FINANCE_ONLY', 'billing', { ruling: 'PR-3 finance_admin requester (a different finance_admin)', operation: 'RECORD', requester_role: 'finance_admin', finance_chain_fulfillable: true, evaluated_at: evaluated_at.toISOString() });
  }
  return chainOf('DISTINCT_PLATFORM_OWNER', 'billing', {
    ruling: 'PR-3 Platform Owner exception (no other eligible finance_admin at creation)',
    operation: 'RECORD',
    requester_role: 'finance_admin',
    exception: true,
    finance_chain_fulfillable: false,
    unfillable_steps: gate.unfillable_steps,
    evaluated_at: evaluated_at.toISOString(),
  });
}

// ---- Refusals -----------------------------------------------------------------------------------

export const PAYMENT_REFUSAL_CODES = [
  'PAYMENT_ALREADY_RECORDED', // PR-6: an effective record exists for the obligation (or the provisional identity)
  'PAYMENT_REFERENCE_DUPLICATE', // PR-6: (tenant, external_invoice_ref, payment_reference) is taken
  'PAYMENT_NOT_RECORDED', // PR-7: no matching applied, unconsumed INITIAL receipt
  'PAYMENT_OBLIGATION_MISMATCH', // PR-7 / PR-9: the receipt or target does not match the obligation
  'PAYMENT_AMOUNT_UNSUPPORTED', // PR-8: partial, over or other-currency payment (fail closed)
  'PAYMENT_RECORD_NOT_GOVERNED', // §5: the target is a Stripe-owned subscription
  'CONTRACT_REF_TAKEN', // §4.2: the provisional ref is an existing contract's (or another receipt's) ref
  'PAYMENT_CORRECTION_TARGET_INVALID', // PR-9: the corrected receipt is absent, of another tenant, or already corrected
  'PAYMENT_TERMS_CHANGE_UNDEFINED', // PR-1 / PR-8: an amendment changes recorded terms (only additions are defined)
] as const;
export type PaymentRefusalCode = (typeof PAYMENT_REFUSAL_CODES)[number];

export class PaymentRecordRefusedError extends Error {
  constructor(
    readonly code: PaymentRefusalCode,
    readonly detail: Record<string, unknown>,
  ) {
    super(`payment record refused (${code})`);
    this.name = 'PaymentRecordRefusedError';
  }
}

const refuse = (code: PaymentRefusalCode, detail: Record<string, unknown> = {}): never => {
  throw new PaymentRecordRefusedError(code, detail);
};

// ---- Rows ---------------------------------------------------------------------------------------

export interface PaymentReceiptRow {
  id: string;
  change_request_id: string;
  tenant_id: string;
  product_key: string;
  entry_kind: 'RECORD' | 'CORRECTION';
  corrects_receipt_id: string | null;
  contract_id: string | null;
  obligation_id: string | null;
  linked_at: Date | null;
  linked_by_change_request_id: string | null;
  provisional_contract_ref: string | null;
  provisional_obligation_ref: string | null;
  provisional_amount_minor: number | null;
  provisional_currency: string | null;
  external_invoice_ref: string;
  amount_minor: number;
  currency: string;
  received_on: string;
  payment_method: string;
  payment_reference: string;
  verification: string | null;
  evidence_documents: unknown;
  origin: string;
  corrected_at: Date | null;
  corrected_by_change_request_id: string | null;
  recorded_by: string;
  recorded_at: Date;
}

const RECEIPT_COLUMNS = `r.id::text AS id, r.change_request_id::text AS change_request_id, r.tenant_id::text AS tenant_id, r.product_key, r.entry_kind,
  r.corrects_receipt_id::text AS corrects_receipt_id, r.contract_id::text AS contract_id, r.obligation_id::text AS obligation_id, r.linked_at,
  r.linked_by_change_request_id::text AS linked_by_change_request_id, r.provisional_contract_ref, r.provisional_obligation_ref,
  r.provisional_amount_minor::float8 AS provisional_amount_minor, r.provisional_currency, r.external_invoice_ref, r.amount_minor::float8 AS amount_minor,
  r.currency, to_char(r.received_on, 'YYYY-MM-DD') AS received_on, r.payment_method, r.payment_reference, r.verification, r.evidence_documents, r.origin,
  r.corrected_at, r.corrected_by_change_request_id::text AS corrected_by_change_request_id, r.recorded_by::text AS recorded_by, r.recorded_at`;

interface ContractTermsRow {
  contract_id: string;
  contract_ref: string;
  subscription_id: string;
  tenant_id: string;
  product_key: string;
  source: string;
  billing_subscription_ref: string | null;
  billing_mode: string | null;
  payment_currency: string | null;
  payment_timezone: string | null;
  grace_days: number | null;
  postpaid_approval: unknown;
  recorded_by_change_request_id: string;
}

const CONTRACT_COLUMNS = `c.id::text AS contract_id, c.contract_ref, s.id::text AS subscription_id, s.tenant_id::text AS tenant_id, s.product_key, s.source,
  s.billing_subscription_ref, c.billing_mode, c.payment_currency, c.payment_timezone, c.grace_days, c.postpaid_approval,
  c.recorded_by_change_request_id::text AS recorded_by_change_request_id`;

interface ObligationRow {
  id: string;
  contract_id: string;
  obligation_ref: string;
  due_date: string;
  amount_minor: number;
  currency: string;
  description: string;
}

const OBLIGATION_COLUMNS = `o.id::text AS id, o.contract_id::text AS contract_id, o.obligation_ref, to_char(o.due_date, 'YYYY-MM-DD') AS due_date,
  o.amount_minor::float8 AS amount_minor, o.currency, o.description`;

async function contractByRef(tx: Reader, contract_ref: string): Promise<ContractTermsRow | null> {
  const rows = await tx.$queryRawUnsafe<ContractTermsRow[]>(
    `SELECT ${CONTRACT_COLUMNS} FROM subscription."Contract" c JOIN subscription."TenantSubscription" s ON s.id = c.tenant_subscription_id WHERE c.contract_ref = $1`,
    contract_ref,
  );
  return rows[0] ?? null;
}

async function obligationOf(tx: Reader, contract_id: string, obligation_ref: string): Promise<ObligationRow | null> {
  const rows = await tx.$queryRawUnsafe<ObligationRow[]>(
    `SELECT ${OBLIGATION_COLUMNS} FROM subscription."ContractPaymentObligation" o WHERE o.contract_id = $1::uuid AND o.obligation_ref = $2`,
    contract_id,
    obligation_ref,
  );
  return rows[0] ?? null;
}

async function receiptById(tx: Reader, id: string, lock = false): Promise<PaymentReceiptRow | null> {
  const rows = await tx.$queryRawUnsafe<PaymentReceiptRow[]>(`SELECT ${RECEIPT_COLUMNS} FROM subscription."CommercialPaymentReceipt" r WHERE r.id = $1::uuid${lock ? ' FOR UPDATE' : ''}`, id);
  return rows[0] ?? null;
}

/** §5 — PAYMENT_RECORD against a provider-owned subscription is refused (it is not governed by CCP). */
function assertGoverned(row: { source: string; billing_subscription_ref: string | null; subscription_id: string }): void {
  if (row.source !== 'MANUAL' || row.billing_subscription_ref !== null) {
    refuse('PAYMENT_RECORD_NOT_GOVERNED', { subscription_id: row.subscription_id, source: row.source, provider_linked: row.billing_subscription_ref !== null });
  }
}

// ---- Resolution of a PAYMENT_RECORD (create and apply) -----------------------------------------------

export type PaymentRecordResolution =
  | { operation: 'RECORD'; mode: 'LINKED'; contract: ContractTermsRow; obligation: ObligationRow }
  | { operation: 'RECORD'; mode: 'PROVISIONAL'; target: Extract<PaymentTarget, { kind: 'PROVISIONAL_INITIAL' }> }
  | { operation: 'CORRECT'; correction: 'REPLACE' | 'VOID'; original: PaymentReceiptRow; consumed_initial: boolean; obligation: ObligationRow | null };

async function assertReferenceFree(tx: Reader, tenant_id: string, e: PaymentEvidence, except_receipt_id: string | null): Promise<void> {
  // PR-6: the triple is unique across ALL records (a replacement may keep the triple of the receipt it
  // replaces: it is the same payment with corrected evidence; divergence D-C8PR-3).
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id::text AS id FROM subscription."CommercialPaymentReceipt"
      WHERE tenant_id = $1::uuid AND external_invoice_ref = $2 AND payment_reference = $3 AND ($4::uuid IS NULL OR id <> $4::uuid) LIMIT 1`,
    tenant_id,
    e.external_invoice_ref,
    e.payment_reference,
    except_receipt_id,
  );
  if (rows.length > 0) refuse('PAYMENT_REFERENCE_DUPLICATE', { external_invoice_ref: e.external_invoice_ref, payment_reference: e.payment_reference });
}

/**
 * Every PR-5 / PR-6 / PR-8 / PR-9 / §4.2 / §5 check of a validated PAYMENT_RECORD payload, inside the
 * caller's transaction (the create, then again the apply: a stale request fails closed). Throws
 * PaymentRecordRefusedError; reads only.
 */
export async function resolvePaymentRecordInTx(tx: Reader, tenant_id: string, product_key: string, p: PaymentRecordPayload): Promise<PaymentRecordResolution> {
  if (p.operation === 'RECORD') {
    const t = p.target;
    if (t.kind === 'CONTRACT_OBLIGATION') {
      const contract = await contractByRef(tx, t.contract_ref);
      // Another tenant's contract is reported exactly like a missing one (no cross-tenant disclosure).
      if (contract === null || contract.tenant_id !== tenant_id || contract.product_key !== product_key) refuse('PAYMENT_OBLIGATION_MISMATCH', { contract_ref: t.contract_ref, reason: 'contract_not_found' });
      const c = contract as ContractTermsRow;
      assertGoverned(c);
      if (c.billing_mode === null) refuse('PAYMENT_OBLIGATION_MISMATCH', { contract_ref: t.contract_ref, reason: 'contract_has_no_payment_terms' });
      const obligation = await obligationOf(tx, c.contract_id, t.obligation_ref);
      if (obligation === null) refuse('PAYMENT_OBLIGATION_MISMATCH', { contract_ref: t.contract_ref, obligation_ref: t.obligation_ref, reason: 'obligation_not_found' });
      const o = obligation as ObligationRow;
      const effective = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text AS id FROM subscription."CommercialPaymentReceipt" WHERE obligation_id = $1::uuid AND corrected_at IS NULL LIMIT 1`,
        o.id,
      );
      if (effective.length > 0) refuse('PAYMENT_ALREADY_RECORDED', { contract_ref: t.contract_ref, obligation_ref: t.obligation_ref, receipt_id: effective[0]?.id });
      if (p.amount_minor !== o.amount_minor || p.currency !== o.currency) {
        refuse('PAYMENT_AMOUNT_UNSUPPORTED', { contract_ref: t.contract_ref, obligation_ref: t.obligation_ref, reason: p.currency !== o.currency ? 'currency_differs' : p.amount_minor < o.amount_minor ? 'partial_payment' : 'overpayment' });
      }
      await assertReferenceFree(tx, tenant_id, p, null);
      return { operation: 'RECORD', mode: 'LINKED', contract: c, obligation: o };
    }
    // §4.2 — the provisional INITIAL identity (tenant, product, provisional_contract_ref).
    if ((await contractByRef(tx, t.contract_ref)) !== null) refuse('CONTRACT_REF_TAKEN', { contract_ref: t.contract_ref });
    const held = await tx.$queryRawUnsafe<Array<{ id: string; tenant_id: string; product_key: string }>>(
      `SELECT id::text AS id, tenant_id::text AS tenant_id, product_key FROM subscription."CommercialPaymentReceipt"
        WHERE provisional_contract_ref = $1 AND linked_at IS NULL AND corrected_at IS NULL`,
      t.contract_ref,
    );
    const mine = held.find((h) => h.tenant_id === tenant_id && h.product_key === product_key);
    if (mine !== undefined) refuse('PAYMENT_ALREADY_RECORDED', { contract_ref: t.contract_ref, obligation_ref: INITIAL_OBLIGATION_REF, receipt_id: mine.id });
    if (held.length > 0) refuse('CONTRACT_REF_TAKEN', { contract_ref: t.contract_ref, reason: 'held_by_an_unlinked_receipt' });
    const open = await tx.$queryRawUnsafe<Array<{ subscription_id: string; source: string; billing_subscription_ref: string | null }>>(
      `SELECT id::text AS subscription_id, source, billing_subscription_ref FROM subscription."TenantSubscription"
        WHERE tenant_id = $1::uuid AND product_key = $2 AND composition_role = 'BASE' AND ended_at IS NULL`,
      tenant_id,
      product_key,
    );
    for (const s of open) if (s.source === 'SELF_SERVICE' || s.billing_subscription_ref !== null) assertGoverned(s);
    if (p.amount_minor !== t.expected_amount_minor || p.currency !== t.expected_currency) {
      refuse('PAYMENT_AMOUNT_UNSUPPORTED', { contract_ref: t.contract_ref, obligation_ref: INITIAL_OBLIGATION_REF, reason: p.currency !== t.expected_currency ? 'currency_differs' : p.amount_minor < t.expected_amount_minor ? 'partial_payment' : 'overpayment' });
    }
    await assertReferenceFree(tx, tenant_id, p, null);
    return { operation: 'RECORD', mode: 'PROVISIONAL', target: t };
  }

  // CORRECT (PR-9).
  const original = await receiptById(tx, p.corrects_receipt_id);
  if (original === null || original.tenant_id !== tenant_id || original.product_key !== product_key) refuse('PAYMENT_CORRECTION_TARGET_INVALID', { corrects_receipt_id: p.corrects_receipt_id, reason: 'receipt_not_found' });
  const o = original as PaymentReceiptRow;
  if (o.corrected_at !== null) refuse('PAYMENT_CORRECTION_TARGET_INVALID', { corrects_receipt_id: o.id, reason: 'already_corrected' });
  const obligation = o.obligation_id === null ? null : ((await tx.$queryRawUnsafe<ObligationRow[]>(`SELECT ${OBLIGATION_COLUMNS} FROM subscription."ContractPaymentObligation" o WHERE o.id = $1::uuid`, o.obligation_id))[0] ?? null);
  // A consumed INITIAL: linked by the SUBSCRIPTION_OPEN apply (it carried the provisional identity).
  const consumed_initial = o.linked_at !== null && o.provisional_contract_ref !== null;
  if (p.correction === 'VOID') {
    if (consumed_initial) refuse('PAYMENT_OBLIGATION_MISMATCH', { corrects_receipt_id: o.id, reason: 'consumed_initial_cannot_be_voided' });
    if (o.linked_at === null && p.no_contract_will_follow !== true) {
      refuse('PAYMENT_CORRECTION_TARGET_INVALID', { corrects_receipt_id: o.id, reason: 'no_contract_will_follow_required' });
    }
    return { operation: 'CORRECT', correction: 'VOID', original: o, consumed_initial, obligation };
  }
  // REPLACE: the same target, corrected evidence; exact settlement still (PR-8).
  const expected = obligation !== null ? { amount_minor: obligation.amount_minor, currency: obligation.currency } : { amount_minor: o.provisional_amount_minor as number, currency: o.provisional_currency as string };
  if (p.amount_minor !== expected.amount_minor || p.currency !== expected.currency) {
    if (consumed_initial) refuse('PAYMENT_OBLIGATION_MISMATCH', { corrects_receipt_id: o.id, reason: 'consumed_initial_would_mismatch_its_contract' });
    refuse('PAYMENT_AMOUNT_UNSUPPORTED', { corrects_receipt_id: o.id, reason: p.currency !== expected.currency ? 'currency_differs' : p.amount_minor < expected.amount_minor ? 'partial_payment' : 'overpayment' });
  }
  await assertReferenceFree(tx, tenant_id, p, o.id);
  return { operation: 'CORRECT', correction: 'REPLACE', original: o, consumed_initial, obligation };
}

// ---- The apply branch (inside the A6 apply transaction) -----------------------------------------

export interface PaymentRecordEffect {
  /** The contract's subscription when the receipt is linked; null for an unlinked provisional INITIAL. */
  subscription_id: string | null;
  events: Array<{ event_type: string; subject: string; payload: Record<string, unknown> }>;
}

function evidenceColumns(e: PaymentEvidence) {
  return {
    external_invoice_ref: e.external_invoice_ref,
    amount_minor: BigInt(e.amount_minor),
    currency: e.currency,
    received_on: new Date(`${e.received_on}T00:00:00.000Z`),
    payment_method: e.payment_method,
    payment_reference: e.payment_reference,
    verification: e.verification ?? null,
    evidence_documents: e.evidence_documents.map((d) => ({ name: d.name, sha256: d.sha256, ...(d.byte_size === undefined ? {} : { byte_size: d.byte_size }), ...(d.media_type === undefined ? {} : { media_type: d.media_type }) })),
    origin: e.origin,
  };
}

async function subscriptionOfContract(tx: Reader, contract_id: string): Promise<string | null> {
  const rows = await tx.$queryRawUnsafe<Array<{ s: string }>>(`SELECT tenant_subscription_id::text AS s FROM subscription."Contract" WHERE id = $1::uuid`, contract_id);
  return rows[0]?.s ?? null;
}

/**
 * PR-4 — the PAYMENT_RECORD domain step: re-resolves (stale → refused), then RECORD inserts one receipt
 * (linked to its obligation, or unlinked with the provisional identity); CORRECT marks the original
 * superseded and, for REPLACE, inserts the replacement on the same target. No obligation, subscription,
 * entitlement or provider is touched.
 */
export async function applyPaymentRecordInTx(
  tx: Tx,
  req: { id: string; requested_by: string },
  p: PaymentRecordPayload,
  tenant_id: string,
  product_key: string,
  now: Date,
): Promise<PaymentRecordEffect> {
  const r = await resolvePaymentRecordInTx(tx, tenant_id, product_key, p);
  const base = { id: uuidv7(), change_request_id: req.id, tenant_id, product_key, recorded_by: req.requested_by, recorded_at: now };
  if (r.operation === 'RECORD') {
    const e = p as Extract<PaymentRecordPayload, { operation: 'RECORD' }>;
    if (r.mode === 'LINKED') {
      await tx.commercialPaymentReceipt.create({
        data: { ...base, entry_kind: 'RECORD', contract_id: r.contract.contract_id, obligation_id: r.obligation.id, linked_at: now, linked_by_change_request_id: req.id, ...evidenceColumns(e) },
      });
      return {
        subscription_id: r.contract.subscription_id,
        events: [{ event_type: 'COMMERCIAL_PAYMENT_RECORDED', subject: `payment_receipt:${base.id}`, payload: { receipt_id: base.id, contract_id: r.contract.contract_id, contract_ref: r.contract.contract_ref, obligation_ref: r.obligation.obligation_ref, linked: true, external_invoice_ref: e.external_invoice_ref, amount_minor: e.amount_minor, currency: e.currency, received_on: e.received_on, payment_method: e.payment_method, origin: e.origin } }],
      };
    }
    await tx.commercialPaymentReceipt.create({
      data: { ...base, entry_kind: 'RECORD', provisional_contract_ref: r.target.contract_ref, provisional_obligation_ref: INITIAL_OBLIGATION_REF, provisional_amount_minor: BigInt(r.target.expected_amount_minor), provisional_currency: r.target.expected_currency, ...evidenceColumns(e) },
    });
    return {
      subscription_id: null,
      events: [{ event_type: 'COMMERCIAL_PAYMENT_RECORDED', subject: `payment_receipt:${base.id}`, payload: { receipt_id: base.id, provisional_contract_ref: r.target.contract_ref, obligation_ref: INITIAL_OBLIGATION_REF, linked: false, external_invoice_ref: e.external_invoice_ref, amount_minor: e.amount_minor, currency: e.currency, received_on: e.received_on, payment_method: e.payment_method, origin: e.origin } }],
    };
  }
  // CORRECT — supersede first (frees the PR-6 / §4.2 indexes), then the replacement.
  const o = r.original;
  await tx.$executeRawUnsafe(
    `UPDATE subscription."CommercialPaymentReceipt" SET corrected_at = $2, corrected_by_change_request_id = $3::uuid WHERE id = $1::uuid`,
    o.id,
    now,
    req.id,
  );
  let replacement_id: string | null = null;
  if (r.correction === 'REPLACE') {
    const e = p as Extract<PaymentRecordPayload, { correction: 'REPLACE' }>;
    replacement_id = base.id;
    await tx.commercialPaymentReceipt.create({
      data: {
        ...base,
        entry_kind: 'CORRECTION',
        corrects_receipt_id: o.id,
        ...(o.linked_at !== null ? { contract_id: o.contract_id, obligation_id: o.obligation_id, linked_at: now, linked_by_change_request_id: req.id } : {}),
        ...(o.provisional_contract_ref !== null
          ? { provisional_contract_ref: o.provisional_contract_ref, provisional_obligation_ref: o.provisional_obligation_ref, provisional_amount_minor: BigInt(o.provisional_amount_minor as number), provisional_currency: o.provisional_currency }
          : {}),
        ...evidenceColumns(e),
      },
    });
  }
  const subscription_id = o.contract_id === null ? null : await subscriptionOfContract(tx, o.contract_id);
  return {
    subscription_id,
    events: [
      {
        event_type: 'COMMERCIAL_PAYMENT_CORRECTED',
        subject: `payment_receipt:${o.id}`,
        payload: {
          corrected_receipt_id: o.id,
          correction: r.correction,
          replacement_receipt_id: replacement_id,
          correction_reason: (p as { correction_reason: string }).correction_reason,
          consumed_initial: r.consumed_initial,
          ...(r.correction === 'VOID' ? { no_contract_will_follow: (p as { no_contract_will_follow?: true }).no_contract_will_follow === true } : {}),
          ...(r.correction === 'REPLACE' ? { amount_minor: (p as PaymentEvidence).amount_minor, currency: (p as PaymentEvidence).currency } : {}),
        },
      },
    ],
  };
}

// ---- PR-7 / §4.3 — the PREPAID gate and link of the SUBSCRIPTION_OPEN apply --------------------------

/**
 * §4.3 steps 1–2 (and K-1 at create): the applied, uncorrected, unlinked INITIAL receipt of
 * (tenant, product, contract_ref), locked FOR UPDATE when `lock`, equal to the payload's INITIAL
 * obligation in amount and currency. Refuses PAYMENT_NOT_RECORDED (none) or PAYMENT_OBLIGATION_MISMATCH.
 */
export async function initialReceiptFor(tx: Reader, tenant_id: string, product_key: string, contract_ref: string, terms: PaymentTermsBlock, lock: boolean): Promise<PaymentReceiptRow> {
  const initial = initialObligationOf(terms) as PaymentObligationTerm;
  const rows = await tx.$queryRawUnsafe<PaymentReceiptRow[]>(
    `SELECT ${RECEIPT_COLUMNS} FROM subscription."CommercialPaymentReceipt" r
      WHERE r.tenant_id = $1::uuid AND r.product_key = $2 AND r.provisional_contract_ref = $3 AND r.linked_at IS NULL AND r.corrected_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    tenant_id,
    product_key,
    contract_ref,
  );
  const r = rows[0];
  if (r === undefined) return refuse('PAYMENT_NOT_RECORDED', { contract_ref, obligation_ref: INITIAL_OBLIGATION_REF });
  if (r.provisional_obligation_ref !== INITIAL_OBLIGATION_REF || r.provisional_amount_minor !== initial.amount_minor || r.amount_minor !== initial.amount_minor || r.provisional_currency !== terms.currency || r.currency !== terms.currency) {
    refuse('PAYMENT_OBLIGATION_MISMATCH', { contract_ref, obligation_ref: INITIAL_OBLIGATION_REF, receipt_id: r.id, reason: 'amount_or_currency_differs' });
  }
  return r;
}

/** §4.2 — a contract being recorded must not take a ref an unlinked receipt holds (other than the one it links). */
export async function assertContractRefFreeOfReceipts(tx: Reader, contract_ref: string, linking_receipt_id: string | null): Promise<void> {
  const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id::text AS id FROM subscription."CommercialPaymentReceipt" WHERE provisional_contract_ref = $1 AND linked_at IS NULL AND corrected_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid) LIMIT 1`,
    contract_ref,
    linking_receipt_id,
  );
  if (rows.length > 0) refuse('CONTRACT_REF_TAKEN', { contract_ref, reason: 'held_by_an_unlinked_receipt' });
}

/** §4.3 step 5 — every PR-1 obligation, with its FK to the contract. Returns ref → id. */
export async function recordObligationsInTx(tx: Tx, contract_id: string, obligations: readonly PaymentObligationTerm[], currency: string, change_request_id: string, now: Date): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const o of obligations) {
    const id = uuidv7();
    await tx.contractPaymentObligation.create({
      data: { id, contract_id, obligation_ref: o.obligation_ref, due_date: new Date(`${o.due_date}T00:00:00.000Z`), amount_minor: BigInt(o.amount_minor), currency, description: o.description, recorded_by_change_request_id: change_request_id, recorded_at: now },
    });
    ids.set(o.obligation_ref, id);
  }
  return ids;
}

/** §4.3 step 6 — link the receipt (the DB guard refuses any cross-tenant, cross-product or other-ref link). */
export async function linkInitialReceiptInTx(tx: Tx, receipt: PaymentReceiptRow, contract: { id: string; contract_ref: string }, obligation_id: string, change_request_id: string, now: Date) {
  await tx.$executeRawUnsafe(
    `UPDATE subscription."CommercialPaymentReceipt" SET contract_id = $2::uuid, obligation_id = $3::uuid, linked_at = $4, linked_by_change_request_id = $5::uuid WHERE id = $1::uuid`,
    receipt.id,
    contract.id,
    obligation_id,
    now,
    change_request_id,
  );
  return {
    event_type: 'COMMERCIAL_PAYMENT_RECEIPT_LINKED' as const,
    subject: `payment_receipt:${receipt.id}`,
    payload: { receipt_id: receipt.id, payment_record_change_request_id: receipt.change_request_id, contract_id: contract.id, contract_ref: contract.contract_ref, obligation_id, obligation_ref: INITIAL_OBLIGATION_REF, linked_at: now.toISOString() },
  };
}

/**
 * PR-1 amendment (v1: additions only). Every recorded obligation must appear unchanged and the
 * contract-level terms equal; anything else fails closed. Returns the obligations to add.
 */
export async function amendmentObligationsToAdd(tx: Reader, contract_id: string, terms: PaymentTermsBlock): Promise<PaymentObligationTerm[]> {
  const rows = await tx.$queryRawUnsafe<Array<{ billing_mode: string | null; payment_currency: string | null; payment_timezone: string | null; grace_days: number | null; postpaid_approval: unknown }>>(
    `SELECT billing_mode, payment_currency, payment_timezone, grace_days, postpaid_approval FROM subscription."Contract" WHERE id = $1::uuid`,
    contract_id,
  );
  const c = rows[0];
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (c === undefined || c.billing_mode === null) refuse('PAYMENT_TERMS_CHANGE_UNDEFINED', { contract_id, reason: 'contract_has_no_payment_terms' });
  const k = c as NonNullable<typeof c>;
  if (k.billing_mode !== terms.billing_mode || k.payment_currency !== terms.currency || k.payment_timezone !== terms.timezone || (k.grace_days ?? null) !== (terms.grace_days ?? null) || !same(k.postpaid_approval, terms.postpaid_approval)) {
    refuse('PAYMENT_TERMS_CHANGE_UNDEFINED', { contract_id, reason: 'contract_terms_differ' });
  }
  const existing = await tx.$queryRawUnsafe<ObligationRow[]>(`SELECT ${OBLIGATION_COLUMNS} FROM subscription."ContractPaymentObligation" o WHERE o.contract_id = $1::uuid`, contract_id);
  for (const e of existing) {
    const n = terms.obligations.find((o) => o.obligation_ref === e.obligation_ref);
    if (n === undefined || n.due_date !== e.due_date || n.amount_minor !== e.amount_minor || n.description !== e.description) {
      refuse('PAYMENT_TERMS_CHANGE_UNDEFINED', { contract_id, obligation_ref: e.obligation_ref, reason: n === undefined ? 'obligation_removed' : 'obligation_changed' });
    }
  }
  return terms.obligations.filter((o) => !existing.some((e) => e.obligation_ref === o.obligation_ref));
}

// ---- PR-10 / PR-11 read model ---------------------------------------------------------------------

export interface ObligationPaymentView {
  obligation_ref: string;
  due_date: string;
  description: string;
  amount_minor: number;
  currency: string;
  status: ObligationPaymentStatus;
  effective_receipt_id: string | null;
}

export interface PaymentReceiptView {
  id: string;
  change_request_id: string;
  entry_kind: 'RECORD' | 'CORRECTION';
  corrects_receipt_id: string | null;
  obligation_ref: string | null;
  external_invoice_ref: string;
  amount_minor: number;
  currency: string;
  received_on: string;
  payment_method: string;
  payment_reference: string;
  verification: string | null;
  evidence_documents: unknown;
  origin: string;
  recorded_by: string;
  recorded_at: Date;
  linked_at: Date | null;
  corrected_at: Date | null;
  corrected_by_change_request_id: string | null;
  /** Uncorrected (PR-9: a superseded record stays in history). */
  effective: boolean;
}

export interface ContractPaymentsView {
  contract_id: string;
  contract_ref: string;
  tenant_id: string;
  product_key: string;
  /** null for a contract recorded without payment terms (before CCP-C8-PR). */
  payment_terms: { billing_mode: string; currency: string; timezone: string; grace_days: number | null; effective_grace_days: number; postpaid_approval: unknown } | null;
  as_of: Date;
  /** Today in the contract timezone (null without terms). */
  as_of_date: string | null;
  payment_due: boolean;
  payment_overdue: boolean;
  obligations: ObligationPaymentView[];
  records: PaymentReceiptView[];
}

export const COMMERCIAL_PAYMENT_CLOCK = Symbol('COMMERCIAL_PAYMENT_CLOCK');

/** An applied, uncorrected INITIAL receipt not yet linked (§4.3 step 5: listed in C6, alerted in D3; never expired). */
export interface UnlinkedReceipt {
  receipt_id: string;
  change_request_id: string;
  tenant_id: string;
  product_key: string;
  provisional_contract_ref: string;
  recorded_at: Date;
}

/** The unlinked receipts, oldest first (no amount: the C6 report and the D3 alert carry none). */
export async function unlinkedReceipts(tx: Reader, filter: { tenant_id?: string; product_key?: string } = {}, limit = 1000): Promise<UnlinkedReceipt[] | null> {
  const present = await tx.$queryRawUnsafe<Array<{ present: boolean }>>(`SELECT to_regclass('subscription."CommercialPaymentReceipt"') IS NOT NULL AS present`);
  if (present[0]?.present !== true) return null;
  return tx.$queryRawUnsafe<UnlinkedReceipt[]>(
    `SELECT r.id::text AS receipt_id, r.change_request_id::text AS change_request_id, r.tenant_id::text AS tenant_id, r.product_key, r.provisional_contract_ref, r.recorded_at
       FROM subscription."CommercialPaymentReceipt" r
      WHERE r.linked_at IS NULL AND r.corrected_at IS NULL AND r.provisional_contract_ref IS NOT NULL
        AND ($1::uuid IS NULL OR r.tenant_id = $1::uuid) AND ($2::text IS NULL OR r.product_key = $2)
      ORDER BY r.recorded_at ASC, r.id ASC LIMIT ${Math.max(1, Math.trunc(limit))}`,
    filter.tenant_id ?? null,
    filter.product_key ?? null,
  );
}

@Injectable()
export class ContractPaymentReadService {
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(COMMERCIAL_PAYMENT_CLOCK) clock?: () => Date,
  ) {
    this.now = clock ?? (() => new Date());
  }

  /** PR-10 — the contract's obligations with their derived status, and every receipt (history kept). */
  async contractPayments(contract_id: string, at: Date = this.now()): Promise<ContractPaymentsView | null> {
    const rows = await this.prisma.$queryRawUnsafe<ContractTermsRow[]>(
      `SELECT ${CONTRACT_COLUMNS} FROM subscription."Contract" c JOIN subscription."TenantSubscription" s ON s.id = c.tenant_subscription_id WHERE c.id = $1::uuid`,
      contract_id,
    );
    const c = rows[0];
    if (c === undefined) return null;
    const obligations = await this.prisma.$queryRawUnsafe<ObligationRow[]>(
      `SELECT ${OBLIGATION_COLUMNS} FROM subscription."ContractPaymentObligation" o WHERE o.contract_id = $1::uuid ORDER BY o.due_date ASC, o.obligation_ref ASC`,
      contract_id,
    );
    const receipts = await this.prisma.$queryRawUnsafe<PaymentReceiptRow[]>(
      `SELECT ${RECEIPT_COLUMNS} FROM subscription."CommercialPaymentReceipt" r WHERE r.contract_id = $1::uuid ORDER BY r.recorded_at ASC, r.id ASC`,
      contract_id,
    );
    const today = c.payment_timezone === null ? null : calendarDateIn(c.payment_timezone, at);
    const obligationViews: ObligationPaymentView[] = obligations.map((o) => {
      const effective = receipts.find((r) => r.obligation_id === o.id && r.corrected_at === null) ?? null;
      return {
        obligation_ref: o.obligation_ref,
        due_date: o.due_date,
        description: o.description,
        amount_minor: o.amount_minor,
        currency: o.currency,
        status: obligationPaymentStatus({ due_date: o.due_date, paid: effective !== null }, c.grace_days, today as string),
        effective_receipt_id: effective?.id ?? null,
      };
    });
    const flags = paymentStatusFlags(obligationViews.map((o) => o.status));
    return {
      contract_id: c.contract_id,
      contract_ref: c.contract_ref,
      tenant_id: c.tenant_id,
      product_key: c.product_key,
      payment_terms:
        c.billing_mode === null
          ? null
          : { billing_mode: c.billing_mode, currency: c.payment_currency as string, timezone: c.payment_timezone as string, grace_days: c.grace_days, effective_grace_days: c.grace_days ?? 0, postpaid_approval: c.postpaid_approval ?? null },
      as_of: at,
      as_of_date: today,
      ...flags,
      obligations: obligationViews,
      records: receipts.map((r) => ({
        id: r.id,
        change_request_id: r.change_request_id,
        entry_kind: r.entry_kind,
        corrects_receipt_id: r.corrects_receipt_id,
        obligation_ref: obligations.find((o) => o.id === r.obligation_id)?.obligation_ref ?? null,
        external_invoice_ref: r.external_invoice_ref,
        amount_minor: r.amount_minor,
        currency: r.currency,
        received_on: r.received_on,
        payment_method: r.payment_method,
        payment_reference: r.payment_reference,
        verification: r.verification,
        evidence_documents: r.evidence_documents,
        origin: r.origin,
        recorded_by: r.recorded_by,
        recorded_at: r.recorded_at,
        linked_at: r.linked_at,
        corrected_at: r.corrected_at,
        corrected_by_change_request_id: r.corrected_by_change_request_id,
        effective: r.corrected_at === null,
      })),
    };
  }
}
