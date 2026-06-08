import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AramoError } from '@aramo/common';
import { describe, expect, it } from 'vitest';

import {
  COMPENSATION_BILL_WRITE_KEYS,
  COMPENSATION_PAY_WRITE_KEYS,
  assertCompensationEditScopes,
} from '../lib/compensation-edit-gate.js';
import type { CreateRequisitionRequestDto } from '../lib/dto/create-requisition-request.dto.js';
import type { UpdateRequisitionRequestDto } from '../lib/dto/update-requisition-request.dto.js';

// D-AUTHZ-COMP-WRITE-1 — the unit-level security proofs (the §4 PL-94
// load-bearing gate). The gate function is a pure boundary check:
// (input × scopes) → throw or return. These tests prove the function
// in isolation; the repository spec proves the gate fires across all 3
// write paths (create / update / createForImport).
//
// The §4 PL-94 proofs covered here:
//   (a) requisition:edit + NO compensation:edit:pay + pay-field payload → 403
//   (b) same for compensation:edit:bill on bill_rate_* / placement_fee_*
//   (c) caller WITH matching edit scope → no throw (happy path)
//   (d) requisition:edit + NO comp edit scope + title-only PATCH → no throw
//       (field-group-specific gate; NOT over-blocking)
//   (h) the rejection is legible (structured details with missing_scopes
//       + attempted_fields)
// Ruling 4: null-as-clear requires the edit scope.
// Ruling 5: compensation_model does NOT require an edit scope.

const REQUEST_ID = 'req-test-d-authz-comp-write-1';

const FULL_RECRUITER_SCOPES: readonly string[] = [
  'requisition:read',
  'requisition:create',
  'requisition:edit',
  'compensation:view:pay',
  'compensation:edit:pay',
];

const RECRUITER_SCOPES_NO_COMP_EDIT: readonly string[] = [
  'requisition:read',
  'requisition:create',
  'requisition:edit',
  'compensation:view:pay',
];

const ACCOUNT_MANAGER_SCOPES: readonly string[] = [
  'requisition:read',
  'requisition:create',
  'requisition:edit',
  'compensation:view:bill',
  'compensation:view:revenue',
  'compensation:view:spread:percent',
  'compensation:view:margin:percent',
  'compensation:edit:bill',
];

const SEE_ALL_SCOPES: readonly string[] = [
  'requisition:read',
  'requisition:read:all',
  'requisition:create',
  'requisition:edit',
  'requisition:delete',
  'compensation:view:pay',
  'compensation:view:bill',
  'compensation:view:revenue',
  'compensation:view:spread:amount',
  'compensation:view:spread:percent',
  'compensation:view:margin:percent',
  'compensation:edit:pay',
  'compensation:edit:bill',
];

describe('assertCompensationEditScopes — field-group catalogues match the writeable surface', () => {
  it('COMPENSATION_PAY_WRITE_KEYS mirrors view:pay (5 stored cols: pay_rate_* + salary_*)', () => {
    expect([...COMPENSATION_PAY_WRITE_KEYS].sort()).toEqual([
      'pay_rate_amount',
      'pay_rate_currency',
      'pay_rate_period',
      'salary_amount',
      'salary_currency',
    ]);
  });

  it('COMPENSATION_BILL_WRITE_KEYS mirrors view:bill (5 stored cols: bill_rate_* + placement_fee_*)', () => {
    expect([...COMPENSATION_BILL_WRITE_KEYS].sort()).toEqual([
      'bill_rate_amount',
      'bill_rate_currency',
      'bill_rate_period',
      'placement_fee_amount',
      'placement_fee_percent',
    ]);
  });
});

describe('assertCompensationEditScopes — (d) field-group-specific gate (NOT over-blocking)', () => {
  it('empty input passes regardless of scopes (no comp write → no scope required)', () => {
    expect(() =>
      assertCompensationEditScopes({ input: {} as never, scopes: [], requestId: REQUEST_ID }),
    ).not.toThrow();
  });

  it('title-only CREATE without any comp scope succeeds (NOT over-blocking — directive §4 (d))', () => {
    const input: CreateRequisitionRequestDto = {
      title: 'Backend Engineer',
      company_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
    };
    expect(() =>
      assertCompensationEditScopes({
        input,
        scopes: RECRUITER_SCOPES_NO_COMP_EDIT,
        requestId: REQUEST_ID,
      }),
    ).not.toThrow();
  });

  it('title + status PATCH without any comp scope succeeds (no comp field-group present)', () => {
    const input: UpdateRequisitionRequestDto = {
      title: 'Backend Engineer (Senior)',
      status: 'on_hold',
    };
    expect(() =>
      assertCompensationEditScopes({
        input,
        scopes: RECRUITER_SCOPES_NO_COMP_EDIT,
        requestId: REQUEST_ID,
      }),
    ).not.toThrow();
  });
});

describe('assertCompensationEditScopes — ruling 5: compensation_model is NOT gated (discriminator, not $)', () => {
  it('compensation_model alone (no $ fields) does not require an edit scope', () => {
    const input: UpdateRequisitionRequestDto = { compensation_model: 'CONTRACT' };
    expect(() =>
      assertCompensationEditScopes({
        input,
        scopes: RECRUITER_SCOPES_NO_COMP_EDIT,
        requestId: REQUEST_ID,
      }),
    ).not.toThrow();
  });

  it('compensation_model + title-only PATCH does not require an edit scope', () => {
    const input: UpdateRequisitionRequestDto = {
      title: 'Senior Backend Engineer',
      compensation_model: 'PERMANENT',
    };
    expect(() =>
      assertCompensationEditScopes({
        input,
        scopes: [],
        requestId: REQUEST_ID,
      }),
    ).not.toThrow();
  });
});

describe('assertCompensationEditScopes — (a) the LOAD-BEARING 403 on pay-field write without edit:pay', () => {
  for (const field of COMPENSATION_PAY_WRITE_KEYS) {
    it(`writing ${field} without compensation:edit:pay → 403 INSUFFICIENT_PERMISSIONS`, () => {
      const input = { title: 'X', [field]: field.endsWith('_period') ? 'HOURLY' : (field.endsWith('_currency') ? 'USD' : '60.00') } as never;
      let caught: unknown;
      try {
        assertCompensationEditScopes({
          input,
          scopes: RECRUITER_SCOPES_NO_COMP_EDIT,
          requestId: REQUEST_ID,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AramoError);
      const e = caught as AramoError;
      expect(e.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(e.statusCode).toBe(403);
      expect(e.context.details?.['reason']).toBe('compensation_edit_scope_missing');
      expect(e.context.details?.['missing_scopes']).toEqual(['compensation:edit:pay']);
      expect(e.context.details?.['attempted_fields']).toContain(field);
    });
  }
});

describe('assertCompensationEditScopes — (b) the LOAD-BEARING 403 on bill-field write without edit:bill', () => {
  for (const field of COMPENSATION_BILL_WRITE_KEYS) {
    it(`writing ${field} without compensation:edit:bill → 403 INSUFFICIENT_PERMISSIONS`, () => {
      const input = { title: 'X', [field]: field.endsWith('_period') ? 'HOURLY' : (field.endsWith('_currency') ? 'USD' : '80.00') } as never;
      let caught: unknown;
      try {
        assertCompensationEditScopes({
          input,
          scopes: RECRUITER_SCOPES_NO_COMP_EDIT,
          requestId: REQUEST_ID,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AramoError);
      const e = caught as AramoError;
      expect(e.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(e.context.details?.['missing_scopes']).toEqual(['compensation:edit:bill']);
      expect(e.context.details?.['attempted_fields']).toContain(field);
    });
  }
});

describe('assertCompensationEditScopes — (c) happy path: matching edit scope passes', () => {
  it('recruiter with edit:pay writes pay_rate_amount → no throw', () => {
    const input: CreateRequisitionRequestDto = {
      title: 'Backend Engineer',
      company_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      pay_rate_amount: '60.00',
      pay_rate_currency: 'USD',
      pay_rate_period: 'HOURLY',
    };
    expect(() =>
      assertCompensationEditScopes({
        input,
        scopes: FULL_RECRUITER_SCOPES,
        requestId: REQUEST_ID,
      }),
    ).not.toThrow();
  });

  it('account_manager with edit:bill writes bill_rate_amount → no throw', () => {
    const input: CreateRequisitionRequestDto = {
      title: 'Account placement',
      company_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      bill_rate_amount: '80.00',
      bill_rate_currency: 'USD',
      bill_rate_period: 'HOURLY',
    };
    expect(() =>
      assertCompensationEditScopes({
        input,
        scopes: ACCOUNT_MANAGER_SCOPES,
        requestId: REQUEST_ID,
      }),
    ).not.toThrow();
  });

  it('see-all tier writes both pay and bill in one payload → no throw', () => {
    const input: CreateRequisitionRequestDto = {
      title: 'TA-authored req',
      company_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      pay_rate_amount: '60.00',
      bill_rate_amount: '80.00',
      placement_fee_amount: '15000.00',
      salary_amount: '120000.00',
    };
    expect(() =>
      assertCompensationEditScopes({
        input,
        scopes: SEE_ALL_SCOPES,
        requestId: REQUEST_ID,
      }),
    ).not.toThrow();
  });
});

describe('assertCompensationEditScopes — both groups missing surfaces BOTH missing scopes', () => {
  it('writing pay + bill without either edit scope rejects with both missing_scopes', () => {
    const input: CreateRequisitionRequestDto = {
      title: 'X',
      company_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      pay_rate_amount: '60.00',
      bill_rate_amount: '80.00',
    };
    let caught: unknown;
    try {
      assertCompensationEditScopes({
        input,
        scopes: RECRUITER_SCOPES_NO_COMP_EDIT,
        requestId: REQUEST_ID,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AramoError);
    const e = caught as AramoError;
    expect(e.context.details?.['missing_scopes']).toEqual([
      'compensation:edit:pay',
      'compensation:edit:bill',
    ]);
    expect(e.context.details?.['attempted_fields']).toEqual(
      expect.arrayContaining(['pay_rate_amount', 'bill_rate_amount']),
    );
  });

  it('caller with ONLY edit:pay attempting both writes rejects with edit:bill missing', () => {
    const input: CreateRequisitionRequestDto = {
      title: 'X',
      company_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
      pay_rate_amount: '60.00',
      bill_rate_amount: '80.00',
    };
    let caught: unknown;
    try {
      assertCompensationEditScopes({
        input,
        scopes: FULL_RECRUITER_SCOPES,
        requestId: REQUEST_ID,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AramoError);
    const e = caught as AramoError;
    expect(e.context.details?.['missing_scopes']).toEqual(['compensation:edit:bill']);
  });
});

describe('assertCompensationEditScopes — ruling 4: null-as-clear requires the edit scope', () => {
  it('PATCH clearing pay_rate_amount with null requires compensation:edit:pay', () => {
    const input: UpdateRequisitionRequestDto = { pay_rate_amount: null };
    expect(() =>
      assertCompensationEditScopes({
        input,
        scopes: RECRUITER_SCOPES_NO_COMP_EDIT,
        requestId: REQUEST_ID,
      }),
    ).toThrow();
  });

  it('PATCH clearing placement_fee_amount with null requires compensation:edit:bill', () => {
    const input: UpdateRequisitionRequestDto = { placement_fee_amount: null };
    expect(() =>
      assertCompensationEditScopes({
        input,
        scopes: RECRUITER_SCOPES_NO_COMP_EDIT,
        requestId: REQUEST_ID,
      }),
    ).toThrow();
  });

  it('PATCH clearing bill_rate_amount with edit:bill succeeds (the clear is the mutation)', () => {
    const input: UpdateRequisitionRequestDto = { bill_rate_amount: null };
    expect(() =>
      assertCompensationEditScopes({
        input,
        scopes: ACCOUNT_MANAGER_SCOPES,
        requestId: REQUEST_ID,
      }),
    ).not.toThrow();
  });
});

// D-AUTHZ-COMP-WRITE-1 — proof (e): all 3 write paths covered. The
// gate function lives at libs/requisition/src/lib/compensation-edit-gate.ts;
// this test asserts (via source-text scan) that each of the 3 repository
// write methods — create, update, createForImport — invokes it BEFORE
// any prisma write. A static check is sufficient here: the gate's
// behavior is proven by the function-level cases above; this proves the
// call sites exist + are sequenced correctly (the source-of-truth is
// the repository diff under review).
//
// Extract a method's body region as the slice from `async METHOD(args:`
// up to the next `async ` (the start of the next method) — or to end of
// source if there is no next method. The slice is over-inclusive (it
// includes the parameter signature + return type) but substring
// ordering still distinguishes gate-vs-write call sites within it,
// which is all this proof needs.
function extractMethodRegion(source: string, methodName: string): string {
  const startMarker = `async ${methodName}(args:`;
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`method ${methodName} not found in source`);
  }
  // Find the next `\n  async ` (sibling method) — note 2-space indent.
  const indentedNext = '\n  async ';
  const next = source.indexOf(indentedNext, start + startMarker.length);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}

describe('assertCompensationEditScopes — (e) all 3 write paths invoke the gate', () => {
  const repoSrc = readFileSync(
    resolve(__dirname, '..', 'lib', 'requisition.repository.ts'),
    'utf8',
  );

  it('the gate helper is imported in requisition.repository.ts', () => {
    expect(repoSrc).toContain("from './compensation-edit-gate.js'");
    expect(repoSrc).toContain('assertCompensationEditScopes');
  });

  for (const [method, write] of [
    ['create', 'prisma.requisition.create('],
    ['update', 'prisma.requisition.update('],
    ['createForImport', 'prisma.requisition.create('],
  ] as const) {
    it(`${method}() invokes assertCompensationEditScopes BEFORE ${write}`, () => {
      const region = extractMethodRegion(repoSrc, method);
      const gateAt = region.indexOf('assertCompensationEditScopes(');
      const writeAt = region.indexOf(write);
      expect(gateAt, `gate not called in ${method}()`).toBeGreaterThanOrEqual(0);
      expect(writeAt, `${write} not called in ${method}()`).toBeGreaterThan(gateAt);
    });
  }
});

describe('assertCompensationEditScopes — (h) legibility (structured rejection)', () => {
  it('rejection carries requestId in context for end-to-end tracing', () => {
    const input: UpdateRequisitionRequestDto = { pay_rate_amount: '60.00' };
    let caught: unknown;
    try {
      assertCompensationEditScopes({
        input,
        scopes: RECRUITER_SCOPES_NO_COMP_EDIT,
        requestId: REQUEST_ID,
      });
    } catch (err) {
      caught = err;
    }
    const e = caught as AramoError;
    expect(e.context.requestId).toBe(REQUEST_ID);
  });
});
