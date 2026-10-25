import { describe, expect, it } from 'vitest';

import { CommercialPayloadError, validatePayload } from '../lib/commercial/commercial-change-request.js';
import { changeCarriesContract } from '../lib/commercial/commercial-contract.js';

// CCP-B4 — the pure payload schema of the contract blocks on the A6 actions (B4-U-*).

const V = '0190dddd-0000-7000-8000-00000000b401';
const S = '0190dddd-0000-7000-8000-00000000b402';
const C = '0190dddd-0000-7000-8000-00000000b403';
const DOC = { name: 'Order form.pdf', sha256: 'a'.repeat(64) };
const open = (extra: Record<string, unknown>) => ({ plan_key: 'aramo-sign-included-v1', plan_version_id: V, replaces_subscription_id: null, ...extra });
const change = (extra: Record<string, unknown>) => ({ subscription_id: S, plan_key: 'aramo-sign-included-v1', plan_version_id: V, ...extra });
const errorsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof CommercialPayloadError) return [...e.errors];
    throw e;
  }
  return [];
};

describe('CCP-B4 contract payload blocks', () => {
  it('B4-U-1 the A6 payloads stay valid without a contract block, and accept a well-formed one', () => {
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({})))).toEqual([]);
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({ contract: { contract_ref: 'CT-2026-021', terms: ['Net 30'], documents: [DOC], evidence_ref: 'OF-8034' } })))).toEqual([]);
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_CHANGE', change({ contract_amendment: { contract_id: C, summary: 'Portal added', documents: [] } })))).toEqual([]);
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_END', { subscription_id: S, contract_end: { contract_id: C, documents: [DOC] } }))).toEqual([]);
  });

  it('B4-U-2 blocks are closed and typed; a change carries at most one block; END admits only contract_end', () => {
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_CHANGE', change({ contract: { contract_ref: 'CT-1', terms: ['a'], documents: [] }, contract_amendment: { contract_id: C, summary: 's', documents: [] } })))).toContain(
      'a change carries either contract or contract_amendment, not both',
    );
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_END', { subscription_id: S, contract: { contract_ref: 'CT-1', terms: ['a'], documents: [] } }))).toEqual(['contract is not a field of this action']);
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({ contract_amendment: { contract_id: C, summary: 's', documents: [] } })))).toEqual(['contract_amendment is not a field of this action']);
    expect(errorsOf(() => validatePayload('SUBSCRIPTION_CHANGE', change({ contract_amendment: { contract_id: 'x', summary: '', documents: [], status: 'ENDED' } })))).toEqual([
      'contract_amendment.status is not a field of this block',
      'contract_amendment.contract_id must be a uuid',
      'contract_amendment.summary must be a non-empty string of at most 500 characters',
    ]);
    // No state, plan or usage can ride a contract block (N-3(c), (d)).
    for (const k of ['status', 'plan_key', 'allowance', 'used', 'ended_at']) {
      expect(errorsOf(() => validatePayload('SUBSCRIPTION_OPEN', open({ contract: { contract_ref: 'CT-2026-1', terms: ['a'], documents: [], [k]: 1 } })))).toEqual([`contract.${k} is not a field of this block`]);
    }
  });

  it('B4-U-3 a same-version change is defined only with a contract block', () => {
    expect(changeCarriesContract(change({}))).toBe(false);
    expect(changeCarriesContract(change({ contract_amendment: {} }))).toBe(true);
    expect(changeCarriesContract(change({ contract: {} }))).toBe(true);
  });
});
