// CCP-B4 (Aramo-CCP-Program-Build-Directive-v1_0-LOCKED §5.3 row B4; MP-A2 N-2, N-3, N-4;
// Charter L6) — the enterprise contract record.
//
// A contract is an evidence-bearing record of a governed MANUAL subscription: negotiated terms
// and hashed evidence documents. It is never a second subscription authority:
//   - it is written ONLY inside the CCP-A6 apply transaction of an approved change request
//     (SUBSCRIPTION_OPEN / SUBSCRIPTION_CHANGE carry `contract`, SUBSCRIPTION_CHANGE carries
//     `contract_amendment`, SUBSCRIPTION_END carries `contract_end`); the DB insert guards
//     (migration 20261026030000) refuse any other writer;
//   - it carries no state: ACTIVE / ENDED is read from the referenced TenantSubscription;
//   - it carries no plan, version, allowance or commitment: those are read through the
//     TenantSubscription (and its pinned PlanVersion), N-3(c);
//   - it carries no usage, N-3(d).
// No resolver (allowance, capacity, entitlement, lifecycle, checkout) reads these tables.
//
// Contract invoicing is NOT built (PBD §10: "B4 / C invoicing for contracts" waits on the
// enterprise invoicing choice). The read model says so explicitly (`invoicing`).
//
// This file is the PURE half (payload blocks and their validation; no I/O). The writes and
// the read model are in commercial-contract.repository.ts.
//
// CCP-C8-PR (Aramo-CCP-Program-Build-Directive-Amendment-A2-Payment-Record-v1_0-LOCKED PR-1): a
// contract recorded under B4 now carries a structured, immutable `payment_terms` block (billing mode,
// POSTPAID marker, currency, IANA timezone, obligations, grace days), separate from the free-text
// `terms` and bound by the payload checksum. A contract record without it is refused; an amendment may
// carry it (commercial-payment-terms.ts validates the block).

import { type PaymentTermsBlock, paymentTermsErrors } from './commercial-payment-terms.js';

// ---- Payload blocks (validated at create and again at apply, frozen with the payload) ----

export interface ContractEvidenceDocument {
  name: string;
  /** Lowercase SHA-256 hex of the document bytes (computed by the recorder; no bytes stored). */
  sha256: string;
  byte_size?: number;
  media_type?: string;
}

/** `contract` on SUBSCRIPTION_OPEN / SUBSCRIPTION_CHANGE: record a contract for the governed row. */
export interface ContractRecordBlock {
  contract_ref: string;
  terms: string[];
  documents: ContractEvidenceDocument[];
  evidence_ref?: string;
  /** CCP-C8-PR PR-1 — required on a contract record. */
  payment_terms: PaymentTermsBlock;
}

/** `contract_amendment` on SUBSCRIPTION_CHANGE. `terms` = the full terms after; omitted = unchanged. */
export interface ContractAmendmentBlock {
  contract_id: string;
  summary: string;
  terms?: string[];
  documents: ContractEvidenceDocument[];
  evidence_ref?: string;
  /**
   * CCP-C8-PR PR-1 — the payment terms after the amendment (full block). v1 admits only ADDED
   * obligations (every recorded obligation, the billing mode, currency, timezone, grace and marker kept
   * byte-equal); any other change fails closed at apply (PAYMENT_TERMS_CHANGE_UNDEFINED).
   */
  payment_terms?: PaymentTermsBlock;
}

/** `contract_end` on SUBSCRIPTION_END of a contract-linked row (required for such a row). */
export interface ContractEndBlock {
  contract_id: string;
  summary?: string;
  documents: ContractEvidenceDocument[];
  evidence_ref?: string;
}

export const CONTRACT_REF_PATTERN = /^[A-Z][A-Z0-9-]{2,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
export const CONTRACT_MAX_TERMS = 50;
export const CONTRACT_MAX_DOCUMENTS = 20;

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function closed(o: Record<string, unknown>, allowed: readonly string[], at: string, errors: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${at}.${k} is not a field of this block`);
}

function text(v: unknown, at: string, max: number, errors: string[], optional = false): void {
  if (v === undefined && optional) return;
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > max) errors.push(`${at} must be a non-empty string of at most ${max} characters`);
}

function terms(v: unknown, at: string, errors: string[]): void {
  if (!Array.isArray(v) || v.length === 0 || v.length > CONTRACT_MAX_TERMS) {
    errors.push(`${at} must be an array of 1 to ${CONTRACT_MAX_TERMS} terms`);
    return;
  }
  v.forEach((t, i) => text(t, `${at}[${i}]`, 500, errors));
}

function documents(v: unknown, at: string, errors: string[]): void {
  if (!Array.isArray(v) || v.length > CONTRACT_MAX_DOCUMENTS) {
    errors.push(`${at} must be an array of at most ${CONTRACT_MAX_DOCUMENTS} documents`);
    return;
  }
  const seen = new Set<string>();
  v.forEach((d, i) => {
    const p = `${at}[${i}]`;
    if (!isObject(d)) {
      errors.push(`${p} must be an object`);
      return;
    }
    closed(d, ['name', 'sha256', 'byte_size', 'media_type'], p, errors);
    text(d['name'], `${p}.name`, 200, errors);
    if (typeof d['sha256'] !== 'string' || !SHA256_HEX.test(d['sha256'])) errors.push(`${p}.sha256 must be a lowercase SHA-256 hex digest`);
    else if (seen.has(d['sha256'])) errors.push(`${p}.sha256 repeats another document`);
    else seen.add(d['sha256']);
    if (d['byte_size'] !== undefined && (typeof d['byte_size'] !== 'number' || !Number.isSafeInteger(d['byte_size']) || d['byte_size'] < 0)) errors.push(`${p}.byte_size must be a non-negative integer`);
    text(d['media_type'], `${p}.media_type`, 100, errors, true);
  });
}

function uuid(v: unknown, at: string, errors: string[]): void {
  if (typeof v !== 'string' || !UUID.test(v)) errors.push(`${at} must be a uuid`);
}

/** The payload keys B4 adds to each A6 action (closed-key extension). */
export const CONTRACT_PAYLOAD_KEYS: Readonly<Record<'SUBSCRIPTION_OPEN' | 'SUBSCRIPTION_CHANGE' | 'SUBSCRIPTION_END', readonly string[]>> = {
  SUBSCRIPTION_OPEN: ['contract'],
  SUBSCRIPTION_CHANGE: ['contract', 'contract_amendment'],
  SUBSCRIPTION_END: ['contract_end'],
};

/**
 * Validates the B4 contract blocks of a SUBSCRIPTION_OPEN / _CHANGE / _END payload (pure).
 * Every block is optional; a CHANGE carries at most one of `contract` / `contract_amendment`.
 */
export function validateContractBlocks(action_type: 'SUBSCRIPTION_OPEN' | 'SUBSCRIPTION_CHANGE' | 'SUBSCRIPTION_END', p: Record<string, unknown>, errors: string[]): void {
  if (p['contract'] !== undefined) {
    const c = p['contract'];
    if (!isObject(c)) errors.push('contract must be an object');
    else {
      closed(c, ['contract_ref', 'terms', 'documents', 'evidence_ref', 'payment_terms'], 'contract', errors);
      if (typeof c['contract_ref'] !== 'string' || !CONTRACT_REF_PATTERN.test(c['contract_ref'])) errors.push('contract.contract_ref must match ^[A-Z][A-Z0-9-]{2,39}$ (e.g. CT-2026-021)');
      terms(c['terms'], 'contract.terms', errors);
      documents(c['documents'], 'contract.documents', errors);
      text(c['evidence_ref'], 'contract.evidence_ref', 500, errors, true);
      paymentTermsErrors(c['payment_terms'], 'contract.payment_terms', errors, true);
    }
  }
  if (p['contract_amendment'] !== undefined) {
    const a = p['contract_amendment'];
    if (action_type === 'SUBSCRIPTION_CHANGE' && p['contract'] !== undefined) errors.push('a change carries either contract or contract_amendment, not both');
    if (!isObject(a)) errors.push('contract_amendment must be an object');
    else {
      closed(a, ['contract_id', 'summary', 'terms', 'documents', 'evidence_ref', 'payment_terms'], 'contract_amendment', errors);
      uuid(a['contract_id'], 'contract_amendment.contract_id', errors);
      text(a['summary'], 'contract_amendment.summary', 500, errors);
      if (a['terms'] !== undefined) terms(a['terms'], 'contract_amendment.terms', errors);
      documents(a['documents'], 'contract_amendment.documents', errors);
      text(a['evidence_ref'], 'contract_amendment.evidence_ref', 500, errors, true);
      paymentTermsErrors(a['payment_terms'], 'contract_amendment.payment_terms', errors, false);
    }
  }
  if (p['contract_end'] !== undefined) {
    const e = p['contract_end'];
    if (!isObject(e)) errors.push('contract_end must be an object');
    else {
      closed(e, ['contract_id', 'summary', 'documents', 'evidence_ref'], 'contract_end', errors);
      uuid(e['contract_id'], 'contract_end.contract_id', errors);
      text(e['summary'], 'contract_end.summary', 500, errors, true);
      documents(e['documents'], 'contract_end.documents', errors);
      text(e['evidence_ref'], 'contract_end.evidence_ref', 500, errors, true);
    }
  }
}

/** True when a SUBSCRIPTION_CHANGE payload records or amends a contract (a terms-only change is then defined). */
export function changeCarriesContract(p: Record<string, unknown>): boolean {
  return p['contract'] !== undefined || p['contract_amendment'] !== undefined;
}

