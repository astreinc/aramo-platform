import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { priceFigure } from '../lib/billing/billing-finance-report.service.js';
import {
  CONTRACT_TERMS_BLOCK_KEYS,
  CONTRACT_TERMS_KEYS,
  FINANCE_AMOUNT_WITHHELD,
  FINANCIAL_EVIDENCE_KEYS,
  FINANCIAL_NOTE_KEYS,
  FINANCIAL_REQUEST_ACTION_TYPES,
  MONETARY_ACTION_TYPES,
  PROVIDER_TEXT_KEYS,
  evidenceVisible,
  isFinancialCommandKind,
  isFinancialRequestAction,
  projectApprovalNotes,
  projectChangeRequestFinance,
  withholdAuditPayloadAmounts,
  withholdContractTerms,
  withholdContractTermsDeep,
  withholdProviderText,
  type FinanceReader,
} from '../lib/billing/finance-amount-withholding.js';
import { BILLING_COMMAND_KINDS } from '../lib/billing/billing-provider-command.js';
import { buildAuditCsv } from '../lib/commercial/commercial-audit-export.service.js';
import type { CommercialAuditEventRow } from '../lib/commercial/commercial-audit.repository.js';
import { COMMERCIAL_ACTION_TYPES, CommercialPayloadError, validatePayload, type CommercialActionType } from '../lib/commercial/commercial-change-request.js';
import type { PlanVersionContent } from '../lib/plan-version.js';

// CCP-R3-W — Architect rulings W-1 / W-2 / W-3 (CCP-UI v1.2 Finance visibility, 2026-10-25) and
// the TD-MERGE-43 residual (C4 refusal detail with provider text). The pure halves, no database:
// the shared projection in finance-amount-withholding.ts, the audit body / CSV export, and the
// provenance proof that the W-3 requester exception is reliable (DB guard + schema + closed
// payload key sets). The HTTP halves are in apps/platform-admin ccp-r3w-*.spec.ts.

const REQUESTER = '019a0000-0000-7000-8000-00000000e301';
const OTHER = '019a0000-0000-7000-8000-00000000e302';
const holder: FinanceReader = { amount_access: true, user_id: OTHER };
const holderRequester: FinanceReader = { amount_access: true, user_id: REQUESTER };
const requester: FinanceReader = { amount_access: false, user_id: REQUESTER };
const nonRequester: FinanceReader = { amount_access: false, user_id: OTHER };
const service: FinanceReader = { amount_access: false, user_id: null };
const W = FINANCE_AMOUNT_WITHHELD;

const refund = {
  action_type: 'REFUND',
  requested_by: REQUESTER,
  reason: 'Duplicate charge on the October invoice',
  rejection_reason: 'Refund not justified by finance',
  payload: { amount_minor: 4321, currency: 'USD', provider_invoice_ref: 'in_abc123', provider_payment_ref: 'pi_abc123', category: 'R1_DUPLICATE', basis: 'Charged twice for one period', refund_policy_ref: 'refund-policy@1.0' },
  required_chain: { rule: 'FINANCE_THEN_OWNER', basis: { amount_minor: 4321, currency: 'USD' }, steps: [] },
};
const credit = { ...refund, action_type: 'CREDIT', payload: { amount_minor: 100, currency: 'USD' }, required_chain: { rule: 'FINANCE_ONLY', basis: { amount_minor: 100, credit_escalation_threshold_minor: 50000, escalates: false }, steps: [] } };
const subscriptionOpen = {
  action_type: 'SUBSCRIPTION_OPEN',
  requested_by: REQUESTER,
  reason: 'Enterprise contract signed',
  rejection_reason: 'Wrong plan version',
  payload: { plan_version_id: 'v', contract: { contract_ref: 'CT-2026-021', terms: ['Invoiced monthly, net 30', '15% negotiated reduction'], documents: [{ name: 'msa.pdf', sha256: 'a'.repeat(64) }] } },
  required_chain: { rule: 'FINANCE_ONLY', basis: {}, steps: [] },
};

describe('CCP-R3-W W-2 — contract terms', () => {
  it('R3W-T-1 a contract projection without access loses terms and recorded_terms and ALWAYS carries terms_withheld (also for an unchanged amendment); with access a deep copy', () => {
    const detail = { id: 'c', terms: ['net 30'], recorded_terms: ['net 30'], summary: 's', evidence_ref: null };
    expect(withholdContractTerms(detail, false)).toEqual({ id: 'c', summary: 's', evidence_ref: null, terms_withheld: W });
    expect(withholdContractTerms({ sequence: 1, terms: null }, false)).toEqual({ sequence: 1, terms_withheld: W });
    expect(withholdContractTerms({ sequence: 2 }, false)).toEqual({ sequence: 2, terms_withheld: W });
    const copy = withholdContractTerms(detail, true);
    expect(copy).toEqual(detail);
    expect(copy['terms']).not.toBe(detail.terms);
    expect(detail.terms).toEqual(['net 30']);
    expect([...CONTRACT_TERMS_KEYS]).toEqual(['terms', 'recorded_terms']);
    expect([...CONTRACT_TERMS_BLOCK_KEYS]).toEqual(['contract', 'contract_amendment']);
  });

  it('R3W-T-2 a payload / audit body: every contract and contract_amendment block (any depth) loses its terms; a plan allowance `terms` list outside a contract block is kept; contract_end carries no terms and is untouched', () => {
    const p = {
      contract: { contract_ref: 'CT-1', terms: ['a'], documents: [] },
      nested: { contract_amendment: { contract_id: 'x', summary: 'raise seats', terms: ['b'], documents: [] } },
      contract_end: { contract_id: 'x', documents: [] },
      terms: ['ALLOWANCE:seats'],
    };
    expect(withholdContractTermsDeep(p, false)).toEqual({
      contract: { contract_ref: 'CT-1', documents: [], terms_withheld: W },
      nested: { contract_amendment: { contract_id: 'x', summary: 'raise seats', documents: [], terms_withheld: W } },
      contract_end: { contract_id: 'x', documents: [] },
      terms: ['ALLOWANCE:seats'],
    });
    expect(withholdContractTermsDeep(p, true)).toEqual(p);
  });

  it('R3W-T-3 a SUBSCRIPTION_OPEN request with a contract: terms withheld for EVERY non-holder (the requester included: W-2 has no requester exception); reason and rejection_reason untouched (not a financial action)', () => {
    for (const reader of [requester, nonRequester, service]) {
      const f = projectChangeRequestFinance(subscriptionOpen, reader);
      expect(f.payload['contract']).toEqual({ contract_ref: 'CT-2026-021', documents: [{ name: 'msa.pdf', sha256: 'a'.repeat(64) }], terms_withheld: W });
      expect(f.reason).toBe('Enterprise contract signed');
      expect(f.rejection_reason).toBe('Wrong plan version');
      expect(f.reason_withheld).toBeUndefined();
      expect(f.notes_withheld).toBeUndefined();
      expect(JSON.stringify(f)).not.toContain('negotiated reduction');
    }
    expect(projectChangeRequestFinance(subscriptionOpen, holder).payload).toEqual(subscriptionOpen.payload);
  });
});

describe('CCP-R3-W W-3 — financial request text', () => {
  it('R3W-R-1 the scope list is CREDIT, DISCOUNT, REFUND, PAYMENT_RECORD (keyed on a list; PAYMENT_RECORD an action since CCP-C8-PR, merge train TD-MERGE-50); every other action type of the 16 is never masked', () => {
    expect([...FINANCIAL_REQUEST_ACTION_TYPES]).toEqual(['CREDIT', 'DISCOUNT', 'REFUND', 'PAYMENT_RECORD']);
    expect((COMMERCIAL_ACTION_TYPES as readonly string[]).includes('PAYMENT_RECORD')).toBe(true);
    expect(isFinancialRequestAction('PAYMENT_RECORD')).toBe(true);
    const others = COMMERCIAL_ACTION_TYPES.filter((a) => !FINANCIAL_REQUEST_ACTION_TYPES.includes(a));
    expect(others.length).toBe(COMMERCIAL_ACTION_TYPES.length - 4);
    expect(others.length).toBe(12);
    for (const action_type of others) {
      const f = projectChangeRequestFinance({ ...credit, action_type, payload: { note: 'x' }, required_chain: { basis: {} } }, nonRequester);
      expect(f.reason, action_type).toBe(credit.reason);
      expect(f.rejection_reason, action_type).toBe(credit.rejection_reason);
      expect(f.reason_withheld, action_type).toBeUndefined();
      expect(f.notes_withheld, action_type).toBeUndefined();
    }
    // every R3 monetary action type is a W-3 financial action type
    for (const a of MONETARY_ACTION_TYPES) expect(isFinancialRequestAction(a)).toBe(true);
  });

  it('R3W-R-2 a non-holder who is NOT the requester: reason → reason_withheld, evidence → evidence_withheld, rejection note → notes_withheld; the amount stays withheld (R3); refs, currency and chain rule kept', () => {
    for (const reader of [nonRequester, service]) {
      const f = projectChangeRequestFinance(refund, reader);
      expect(f.reason).toBeUndefined();
      expect(f.reason_withheld).toBe(W);
      expect(f.rejection_reason).toBeUndefined();
      expect(f.notes_withheld).toBe(W);
      expect(f.payload).toEqual({ currency: 'USD', provider_invoice_ref: 'in_abc123', provider_payment_ref: 'pi_abc123', amount_withheld: W, evidence_withheld: W });
      expect(f.basis).toEqual({ currency: 'USD', amount_withheld: W });
    }
  });

  it('R3W-R-3 the ORIGINAL requester without the scope sees their OWN reason and evidence; the rejection note (added after create by someone else) and the amount stay withheld', () => {
    const f = projectChangeRequestFinance(refund, requester);
    expect(f.reason).toBe(refund.reason);
    expect(f.reason_withheld).toBeUndefined();
    expect(f.rejection_reason).toBeUndefined();
    expect(f.notes_withheld).toBe(W);
    expect(f.payload).toEqual({ currency: 'USD', provider_invoice_ref: 'in_abc123', provider_payment_ref: 'pi_abc123', category: 'R1_DUPLICATE', basis: 'Charged twice for one period', refund_policy_ref: 'refund-policy@1.0', amount_withheld: W });
  });

  it('R3W-R-4 a holder (requester or not) receives everything as stored', () => {
    for (const reader of [holder, holderRequester]) {
      const f = projectChangeRequestFinance(refund, reader);
      expect(f.payload).toEqual(refund.payload);
      expect(f.basis).toEqual(refund.required_chain.basis);
      expect(f.reason).toBe(refund.reason);
      expect(f.rejection_reason).toBe(refund.rejection_reason);
    }
  });

  it('R3W-R-5 CREDIT / DISCOUNT carry no evidence key (closed key sets), so no evidence_withheld appears; the reason is still withheld from a non-requester', () => {
    const c = projectChangeRequestFinance(credit, nonRequester);
    expect(c.payload).toEqual({ currency: 'USD', amount_withheld: W });
    expect(c.reason_withheld).toBe(W);
    const d = projectChangeRequestFinance({ ...credit, action_type: 'DISCOUNT', payload: { discount_bps: 2000 } }, nonRequester);
    expect(d.payload).toEqual({ discount_bps: 2000 });
    expect(d.reason_withheld).toBe(W);
    // PAYMENT_RECORD (future): keyed on the list, fail closed on its text.
    const pr = projectChangeRequestFinance({ ...credit, action_type: 'PAYMENT_RECORD', payload: { basis: 'wire' } }, nonRequester);
    expect(pr.reason_withheld).toBe(W);
    expect(pr.payload).toEqual({ evidence_withheld: W });
  });

  it('R3W-R-6 approver comments: withheld (notes_withheld) on a financial request for EVERY non-holder, requester included; kept for holders and on non-financial requests', () => {
    const a = { id: 'a', comment: 'Within the credit policy', step_index: 0 };
    for (const reader of [requester, nonRequester, service]) expect(projectApprovalNotes('CREDIT', a, reader)).toEqual({ id: 'a', step_index: 0, notes_withheld: W });
    expect(projectApprovalNotes('CREDIT', { ...a, comment: null }, requester)).toEqual({ id: 'a', step_index: 0, notes_withheld: W });
    expect(projectApprovalNotes('CREDIT', a, holder)).toEqual(a);
    expect(projectApprovalNotes('SUBSCRIPTION_OPEN', a, nonRequester)).toEqual(a);
  });

  it('R3W-R-7 report evidence (the refund report category): visible to a holder and to the row requester only', () => {
    expect(evidenceVisible(REQUESTER, holder)).toBe(true);
    expect(evidenceVisible(REQUESTER, requester)).toBe(true);
    expect(evidenceVisible(REQUESTER, nonRequester)).toBe(false);
    expect(evidenceVisible(REQUESTER, service)).toBe(false);
  });
});

describe('CCP-R3-W W-3 — provenance (the requester exception is reliable, else fail closed)', () => {
  const MIG = resolve(__dirname, '../../prisma/migrations');
  const migrations = readdirSync(MIG).filter((d) => !d.endsWith('.toml')).sort();
  const sql = (d: string): string => readFileSync(resolve(MIG, d, 'migration.sql'), 'utf8');
  const lastWriter = (fn: string): string => {
    const writers = migrations.filter((d) => sql(d).includes(`CREATE OR REPLACE FUNCTION "subscription"."${fn}"()`));
    expect(writers.length, fn).toBeGreaterThan(0);
    return writers[writers.length - 1] as string;
  };

  it('R3W-P-1 the LAST writer of guard_commercial_change_request() makes payload, reason and requested_by immutable after INSERT (requester text is set only at create)', () => {
    const last = lastWriter('guard_commercial_change_request');
    expect(last).toBe('20261027000000_ccp_guard_union');
    const body = sql(last);
    const block = body.slice(body.indexOf('IF NEW."id" IS DISTINCT FROM OLD."id"'), body.indexOf("RAISE EXCEPTION 'CommercialChangeRequest payload, chain and identity are immutable'"));
    for (const col of ['payload', 'payload_checksum', 'reason', 'requested_by', 'action_type', 'created_at']) expect(block, col).toContain(`NEW."${col}" IS DISTINCT FROM OLD."${col}"`);
    expect(block).not.toContain('rejection_reason');
  });

  it('R3W-P-2 approver comments live in CommercialApproval rows (append-only: UPDATE and DELETE rejected), never on the request row', () => {
    const a3 = sql('20261025120000_ccp_a3_change_request_approval');
    expect(a3).toContain("RAISE EXCEPTION 'CommercialApproval is append-only evidence (% rejected)', TG_OP;");
    expect(a3).toMatch(/BEFORE UPDATE ON "subscription"\."CommercialApproval"[\s\S]*?reject_commercial_approval_mutation/);
    expect(a3).toMatch(/BEFORE DELETE ON "subscription"\."CommercialApproval"[\s\S]*?reject_commercial_approval_mutation/);
    expect(lastWriter('reject_commercial_approval_mutation')).toBe('20261025120000_ccp_a3_change_request_approval');
    const schema = readFileSync(resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
    const model = (name: string): string => schema.slice(schema.indexOf(`model ${name} {`), schema.indexOf('}', schema.indexOf(`model ${name} {`)));
    expect(model('CommercialApproval')).toMatch(/\n\s+comment\s+String\?/);
    expect(model('CommercialChangeRequest')).not.toMatch(/\n\s+comment\s/);
  });

  it('R3W-P-3 every free-text column of CommercialChangeRequest is either immutable at create (reason) or a later annotation that is ALWAYS withheld (rejection_reason ∈ FINANCIAL_NOTE_KEYS): no later text shares storage with requester text', () => {
    const schema = readFileSync(resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
    const start = schema.indexOf('model CommercialChangeRequest {');
    const model = schema.slice(start, schema.indexOf('\n}', start));
    const stringCols = [...model.matchAll(/\n\s+(\w+)\s+String\??(\s|$)/g)].map((m) => m[1] as string);
    // ids / enums / checksums (not free text) are closed by CHECKs or are uuids.
    const notText = ['id', 'action_type', 'kind', 'state', 'tenant_id', 'product_key', 'payload_checksum', 'policy_version_id', 'policy_checksum', 'requested_by', 'idempotency_key', 'rejected_by'];
    const text = stringCols.filter((c) => !notText.includes(c));
    expect(text.sort()).toEqual(['reason', 'rejection_reason']);
    const guard = sql(lastWriter('guard_commercial_change_request'));
    expect(guard).toContain('NEW."reason" IS DISTINCT FROM OLD."reason"');
    expect(FINANCIAL_NOTE_KEYS).toContain('rejection_reason');
    expect(FINANCIAL_NOTE_KEYS).toContain('comment');
  });

  it('R3W-P-4 the payload evidence keys exist only in the REFUND closed key set; CREDIT and DISCOUNT refuse any of them (so no notes or evidence can be added to them)', () => {
    const base: Record<string, Record<string, unknown>> = {
      CREDIT: { amount_minor: 1, currency: 'USD' },
      DISCOUNT: { discount_bps: 100 },
    };
    for (const [a, p] of Object.entries(base)) {
      expect(() => validatePayload(a as CommercialActionType, p)).not.toThrow();
      for (const k of [...FINANCIAL_EVIDENCE_KEYS, 'notes', 'note']) {
        expect(() => validatePayload(a as CommercialActionType, { ...p, [k]: 'x' }), `${a}.${k}`).toThrow(CommercialPayloadError);
      }
    }
    const r = { amount_minor: 1, currency: 'USD', provider_invoice_ref: 'in_abc', provider_payment_ref: 'pi_abc', category: 'R1_DUPLICATE', basis: 'b', refund_policy_ref: 'refund-policy@1.0' };
    expect(() => validatePayload('REFUND', r)).not.toThrow();
    for (const k of ['notes', 'note', 'comment']) expect(() => validatePayload('REFUND', { ...r, [k]: 'x' })).toThrow(CommercialPayloadError);
  });
});

describe('CCP-R3-W item 3 — provider error text in refusal details', () => {
  it('R3W-D-1 REFUND_REMAINDER_UNVERIFIABLE (provider_read_failed) keeps refusal and basis; its provider `error` text reaches a holder only (detail_withheld otherwise)', () => {
    const d = { reason: 'refund_not_refundable', refusal: 'REFUND_REMAINDER_UNVERIFIABLE', basis: 'provider_read_failed', error: 'Stripe: No such payment_intent pi_123 (amount 4321)' };
    expect(withholdProviderText(d, false)).toEqual({ reason: 'refund_not_refundable', refusal: 'REFUND_REMAINDER_UNVERIFIABLE', basis: 'provider_read_failed', detail_withheld: W });
    expect(withholdProviderText(d, true)).toEqual(d);
    expect(withholdProviderText({ outcomes: [{ message: 'x', code: 'c' }] }, false)).toEqual({ outcomes: [{ code: 'c', detail_withheld: W }] });
    expect(withholdProviderText({ refusal: 'REFUND_EXCEEDS_REMAINDER', remainder_known: true }, false)).toEqual({ refusal: 'REFUND_EXCEEDS_REMAINDER', remainder_known: true });
    expect([...PROVIDER_TEXT_KEYS]).toEqual(['error', 'message', 'last_error', 'last_error_detail', 'last_detail']);
  });

  it('R3W-D-2 the financial command kinds are exactly the C4 adjustment kinds (5 of the 7); cancel and checkout-expire are not', () => {
    expect(BILLING_COMMAND_KINDS.filter(isFinancialCommandKind)).toEqual(['CREDIT_GRANT', 'CREDIT_REVERSE', 'DISCOUNT_APPLY', 'DISCOUNT_REMOVE', 'REFUND_CREATE']);
    expect(BILLING_COMMAND_KINDS.length).toBe(7);
  });
});

describe('CCP-R3-W — audit bodies and the B5 CSV export', () => {
  const row = (payload: Record<string, unknown>, event_type = 'COMMERCIAL_CHANGE_REQUEST_APPLIED'): CommercialAuditEventRow => ({
    id: 'e1',
    actor_id: null,
    actor_type: 'user',
    actor_role_keys: ['commercial_ops'],
    event_type,
    is_exception: false,
    tenant_id: null,
    subject: 's',
    change_request_id: 'cr',
    policy_version_id: 'p',
    payload,
    correlation_id: 'c',
    created_at: new Date('2026-10-25T00:00:00.000Z'),
  });
  const names = { actors: new Map<string, string>(), tenants: new Map<string, string>() };

  it('R3W-A-1 a financial event body without access: reason → reason_withheld, rejection/approval notes → notes_withheld, provider text → detail_withheld, amount → amount_withheld; non-financial bodies keep reason; contract terms withheld anywhere', () => {
    const applied = { action_type: 'CREDIT', reason: 'Goodwill credit for a service outage', amount_minor: 100, detail: { error: 'provider said no' } };
    expect(withholdAuditPayloadAmounts(applied, false)).toEqual({ action_type: 'CREDIT', detail: { detail_withheld: W }, amount_withheld: W, reason_withheld: W });
    expect(withholdAuditPayloadAmounts({ action_type: 'REFUND', step_index: 0, reason: 'Refund not justified', comment: 'c' }, false)).toEqual({ action_type: 'REFUND', step_index: 0, reason_withheld: W, notes_withheld: W });
    expect(withholdAuditPayloadAmounts({ action_type: 'ROLE_REVOKE', reason: 'left the company' }, false)).toEqual({ action_type: 'ROLE_REVOKE', reason: 'left the company' });
    expect(withholdAuditPayloadAmounts({ action_type: 'SUBSCRIPTION_OPEN', reason: 'r', contract: { contract_ref: 'CT-1', terms: ['15% off'] } }, false)).toEqual({ action_type: 'SUBSCRIPTION_OPEN', reason: 'r', contract: { contract_ref: 'CT-1', terms_withheld: W } });
    expect(withholdAuditPayloadAmounts(applied, true)).toEqual(applied);
  });

  it('R3W-A-2 the CSV export detail column (a non-holder exporter) carries no reason, note, term or provider text; a holder export carries them', () => {
    const rows = [
      row({ action_type: 'CREDIT', reason: 'Goodwill credit for a service outage', amount_minor: 100 }),
      row({ action_type: 'REFUND', reason: 'Refund not justified', step_index: 0 }, 'COMMERCIAL_CHANGE_REQUEST_REJECTED'),
      row({ action_type: 'REFUND', refusal: 'REFUND_REMAINDER_UNVERIFIABLE', detail: { basis: 'provider_read_failed', error: 'Stripe timeout reading pi_1' } }, 'COMMERCIAL_CHANGE_REQUEST_APPLY_REFUSED'),
      row({ action_type: 'SUBSCRIPTION_OPEN', contract: { contract_ref: 'CT-1', terms: ['15% negotiated reduction'] } }),
    ];
    const withheld = buildAuditCsv(rows, { ...names, amount_access: false });
    for (const secret of ['Goodwill credit', 'Refund not justified', 'Stripe timeout', '15% negotiated', '"amount_minor"']) expect(withheld, secret).not.toContain(secret);
    expect(withheld).toContain('reason_withheld');
    expect(withheld).toContain('detail_withheld');
    expect(withheld).toContain('terms_withheld');
    const flagless = buildAuditCsv(rows, names);
    expect(flagless).toBe(withheld);
    const full = buildAuditCsv(rows, { ...names, amount_access: true });
    for (const secret of ['Goodwill credit', 'Refund not justified', 'Stripe timeout', '15% negotiated']) expect(full, secret).toContain(secret);
  });
});

describe('CCP-R3-W W-1 — catalog list prices visible; no effective tenant price derived', () => {
  const content = (sales_model: string, list_price_minor: number | null): PlanVersionContent =>
    ({ plan: { sales_model, list_price_minor, currency: 'USD', billing_interval: 'MONTH', commitment_months: null } }) as unknown as PlanVersionContent;

  it('R3W-W1-1 a published list price is returned as the catalog figure beside the pinned version (price_source PINNED_PLAN_VERSION); a contract-priced plan has NO price at all (CONTRACT_PRICED) — nothing is derived from contract terms', () => {
    expect(priceFigure(content('SELF_SERVE', 5900), 'pv', 'PINNED_PLAN_VERSION')).toEqual({ list_price: { amount_minor: 5900, currency: 'USD', billing_interval: 'MONTH' }, unpriced_reason: null, price_source: 'PINNED_PLAN_VERSION', plan_version_id: 'pv' });
    expect(priceFigure(content('CONTACT_SALES', null), 'pv', 'PINNED_PLAN_VERSION')).toEqual({ list_price: null, unpriced_reason: 'CONTRACT_PRICED', price_source: 'PINNED_PLAN_VERSION', plan_version_id: 'pv' });
  });

  it('R3W-W1-2 the projection helpers never treat a list price as a tenant amount (FA-3): list_price_minor survives every non-holder projection', () => {
    const f = projectChangeRequestFinance({ ...credit, payload: { amount_minor: 1, currency: 'USD', list_price_minor: 5900 } }, nonRequester);
    expect(f.payload['list_price_minor']).toBe(5900);
    expect(f.payload['amount_minor']).toBeUndefined();
  });
});
