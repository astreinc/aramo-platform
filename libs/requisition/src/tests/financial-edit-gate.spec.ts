import { AramoError } from '@aramo/common';
import { describe, expect, it } from 'vitest';

import {
  REQUISITION_FINANCIAL_WRITE_KEYS,
  assertFinancialEditScopes,
} from '../lib/field-group-edit-gate.js';
import { assertCompensationEditScopes } from '../lib/compensation-edit-gate.js';

// Job-Module LB-4 — the financial write-gate unit proofs (§4 gate 5,
// write side). Mirrors the compensation-edit-gate proofs. Also a
// regression check that the PROMOTED shared primitive did not change the
// compensation gate's external behavior.

const REQUEST_ID = 'req-test-job-module-financials';

const AGENCY_SCOPES: readonly string[] = [
  'requisition:edit',
  'requisition:view:financials',
  'requisition:edit:financials',
];
const RECRUITER_SCOPES: readonly string[] = ['requisition:edit'];

describe('Job-Module LB-4 — requisition financial write-gate', () => {
  it('rejects 403 when a non-holder writes a financial field', () => {
    let thrown: AramoError | null = null;
    try {
      assertFinancialEditScopes({
        input: { target_margin_percent: '20.00' },
        scopes: RECRUITER_SCOPES,
        requestId: REQUEST_ID,
      });
    } catch (e) {
      thrown = e as AramoError;
    }
    expect(thrown).toBeInstanceOf(AramoError);
    expect(thrown?.statusCode).toBe(403);
    expect(thrown?.code).toBe('INSUFFICIENT_PERMISSIONS');
    expect(thrown?.context.details?.['reason']).toBe('financial_edit_scope_missing');
    expect(thrown?.context.details?.['missing_scopes']).toContain('requisition:edit:financials');
  });

  it('null-as-clear of a financial field is gated (a clear is a write)', () => {
    expect(() =>
      assertFinancialEditScopes({
        input: { rate_card_id: null },
        scopes: RECRUITER_SCOPES,
        requestId: REQUEST_ID,
      }),
    ).toThrow(AramoError);
  });

  it('a holder writing financial fields passes', () => {
    expect(() =>
      assertFinancialEditScopes({
        input: { min_bill_rate: '120.00', max_bill_rate: '160.00' },
        scopes: AGENCY_SCOPES,
        requestId: REQUEST_ID,
      }),
    ).not.toThrow();
  });

  it('no-ops when the input carries zero financial fields (title-only)', () => {
    expect(() =>
      assertFinancialEditScopes({
        input: { title: 'x' },
        scopes: RECRUITER_SCOPES,
        requestId: REQUEST_ID,
      }),
    ).not.toThrow();
  });

  it('gates every one of the 7 financial write-keys', () => {
    for (const key of REQUISITION_FINANCIAL_WRITE_KEYS) {
      expect(() =>
        assertFinancialEditScopes({
          input: { [key]: 'x' },
          scopes: RECRUITER_SCOPES,
          requestId: REQUEST_ID,
        }),
      ).toThrow(AramoError);
    }
  });

  it('regression: the promoted comp gate still rejects pay-write without edit:pay', () => {
    expect(() =>
      assertCompensationEditScopes({
        input: { pay_rate_amount: '60.00' },
        scopes: ['requisition:edit'],
        requestId: REQUEST_ID,
      }),
    ).toThrow(AramoError);
  });

  it('regression: comp gate no-ops on a financial-only write (separate families)', () => {
    // A financial-only payload carries no comp field → the comp gate is a
    // no-op (the financial gate handles it). Proves the two families are
    // independent.
    expect(() =>
      assertCompensationEditScopes({
        input: { target_margin_percent: '20.00' },
        scopes: ['requisition:edit'],
        requestId: REQUEST_ID,
      }),
    ).not.toThrow();
  });
});
