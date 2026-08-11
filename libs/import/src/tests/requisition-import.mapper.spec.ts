import { describe, expect, it } from 'vitest';

import {
  mapCanonicalRequisition,
  RequisitionImportMappingError,
} from '../lib/requisition-import.mapper.js';
import type { CanonicalRequisitionImportRecord } from '../lib/dto/canonical-requisition-import.dto.js';

// T8-P2 — provider-neutral canonical requisition mapper. Pure validation +
// mapping of a CanonicalRequisitionImportRecord into a CreateRequisitionRequestDto
// (the input to the governed createForImport path). Every rejection is a bounded,
// stable failure TOKEN (RequisitionImportMappingError.token) — the ImportFailure
// substrate convention, NOT an ErrorCode.
//
// Boundaries (directive §19): D invalid identity · E lifecycle (no gated bypass) ·
// F openings→total-only · H unsupported/person-specific rejected · I req-level
// commercial via existing gated fields · K deterministic per-record failure.

const REQ = '00000000-0000-4000-8000-0000000000t8';
const COMPANY = '01900000-0000-7000-8000-0000000000c1';

function base(overrides: Partial<CanonicalRequisitionImportRecord> = {}): CanonicalRequisitionImportRecord {
  return {
    source_system: 'Fieldglass',
    external_req_id: 'REQ-1',
    title: 'Senior Engineer',
    openings: 2,
    company_id: COMPANY,
    ...overrides,
  } as CanonicalRequisitionImportRecord;
}

function expectToken(fn: () => unknown, token: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RequisitionImportMappingError);
    expect((e as RequisitionImportMappingError).token).toBe(token);
    return;
  }
  throw new Error(`expected RequisitionImportMappingError('${token}'), none thrown`);
}

describe('mapCanonicalRequisition — happy path', () => {
  it('maps a valid record and canonicalizes source_system (T8-P1 identity)', () => {
    const dto = mapCanonicalRequisition(base(), undefined, REQ);
    expect(dto.source_system).toBe('fieldglass'); // canonicalized
    expect(dto.external_req_id).toBe('REQ-1');
    expect(dto.title).toBe('Senior Engineer');
    expect(dto.openings).toBe(2);
    expect(dto.company_id).toBe(COMPANY);
    // No external_status → status omitted; the repository create path applies its
    // own `?? 'open'` default (single source of truth), proven end-to-end in the
    // integration spec.
    expect(dto.status).toBeUndefined();
  });

  it('never emits an openings_available field (capacity truth is derived — §8/G)', () => {
    const dto = mapCanonicalRequisition(base({ openings: 5 }), undefined, REQ);
    expect(dto.openings).toBe(5);
    expect((dto as Record<string, unknown>)['openings_available']).toBeUndefined();
  });
});

describe('D — external identity', () => {
  it('rejects a blank/malformed source_system', () => {
    expectToken(() => mapCanonicalRequisition(base({ source_system: 'field glass!' }), undefined, REQ), 'INVALID_EXTERNAL_IDENTITY');
  });
  it('rejects a missing external_req_id', () => {
    expectToken(() => mapCanonicalRequisition(base({ external_req_id: '   ' }), undefined, REQ), 'INVALID_EXTERNAL_IDENTITY');
  });
});

describe('E — lifecycle mapping (no gated bypass, §9)', () => {
  it('maps an external status token via the supplied mapping', () => {
    const dto = mapCanonicalRequisition(base({ external_status: 'ON_HOLD' }), { on_hold: 'on_hold' }, REQ);
    expect(dto.status).toBe('on_hold');
  });
  it('rejects a gated internal status (draft/pending_approval/archived) — import must not bypass the gate', () => {
    expectToken(() => mapCanonicalRequisition(base({ external_status: 'X' }), { x: 'draft' }, REQ), 'GATED_STATUS_NOT_IMPORTABLE');
  });
  it('rejects an unmapped external status token', () => {
    expectToken(() => mapCanonicalRequisition(base({ external_status: 'WEIRD' }), { other: 'open' }, REQ), 'UNSUPPORTED_LIFECYCLE_STATUS');
  });
  it('rejects a mapping that targets a non-RecruitingStatus value', () => {
    expectToken(() => mapCanonicalRequisition(base({ external_status: 'S' }), { s: 'not_a_status' }, REQ), 'UNSUPPORTED_LIFECYCLE_STATUS');
  });
});

describe('F — openings maps only to the stored total capacity authority (§8)', () => {
  it('maps openings straight to the total; over-capacity-representable values are allowed', () => {
    expect(mapCanonicalRequisition(base({ openings: 0 }), undefined, REQ).openings).toBe(0);
  });
  it('rejects a negative or non-integer openings', () => {
    expectToken(() => mapCanonicalRequisition(base({ openings: -1 }), undefined, REQ), 'INVALID_OPENINGS');
    expectToken(() => mapCanonicalRequisition(base({ openings: 2.5 }), undefined, REQ), 'INVALID_OPENINGS');
  });
});

describe('H — unsupported / person-specific fields rejected (§6/§7 T5 boundary)', () => {
  it('rejects an unknown key rather than silently discarding it', () => {
    expectToken(() => mapCanonicalRequisition(base({ custom_blob: { a: 1 } } as never), undefined, REQ), 'UNSUPPORTED_FIELD');
  });
  it('rejects a person/assignment-specific commercial term (T5-owned)', () => {
    // worker_pay_rate is assignment-economics, never a requisition field.
    expectToken(() => mapCanonicalRequisition(base({ worker_pay_rate: '85.00' } as never), undefined, REQ), 'UNSUPPORTED_FIELD');
  });
});

describe('I — req-level commercial maps to existing gated fields (§7)', () => {
  it('maps a requisition-level bill rate to the existing gated bill_rate_* fields', () => {
    const dto = mapCanonicalRequisition(
      base({ bill_rate_amount: '120.00', bill_rate_currency: 'USD', bill_rate_period: 'HOURLY' }),
      undefined,
      REQ,
    );
    expect(dto.bill_rate_amount).toBe('120.00');
    expect(dto.bill_rate_currency).toBe('USD');
    expect(dto.bill_rate_period).toBe('HOURLY');
  });
  it('rejects a malformed commercial decimal', () => {
    expectToken(() => mapCanonicalRequisition(base({ bill_rate_amount: 'abc' }), undefined, REQ), 'INVALID_COMMERCIAL_VALUE');
  });
  it('rejects an invalid bill_rate_period (bounded, not an opaque enum error)', () => {
    expectToken(() => mapCanonicalRequisition(base({ bill_rate_period: 'hour' }), undefined, REQ), 'INVALID_COMMERCIAL_VALUE');
  });
});

describe('missing required fields', () => {
  it('rejects a missing title', () => {
    expectToken(() => mapCanonicalRequisition(base({ title: '' }), undefined, REQ), 'MISSING_REQUIRED_FIELD');
  });
  it('rejects a missing company_id', () => {
    expectToken(() => mapCanonicalRequisition(base({ company_id: '' }), undefined, REQ), 'MISSING_REQUIRED_FIELD');
  });
});
