import { describe, expect, it } from 'vitest';

import {
  isCanonicalSourceSystemKey,
  MAX_SOURCE_SYSTEM_LENGTH,
  normalizeSourceSystem,
} from '../lib/dto/source-system.js';
import { resolveExternalIdentity } from '../lib/external-identity-validation.js';

// Assert fn throws an AramoError carrying the given code + HTTP status.
function expectValidationError(fn: () => unknown): void {
  try {
    fn();
  } catch (e) {
    const err = e as { code?: string; statusCode?: number };
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.statusCode).toBe(400);
    return;
  }
  throw new Error('expected a VALIDATION_ERROR to be thrown, but none was');
}

// T8-P1 Boundary A — backend source-identifier validation.
//
// The VMS canonical model (T8 VMS Integration Directive v1.0 §4) rules OUT a
// closed Postgres enum built from the FE 7-provider example list. The backend
// identifier is a VALIDATED, EXTENSIBLE canonical string: normalized to a
// deterministic lowercase provider key, malformed/blank rejected, no arbitrary
// display text, and a new provider needs NO enum migration. Normalization is
// load-bearing for the idempotency invariant: 'Fieldglass' and 'fieldglass'
// MUST collapse to one key or the (tenant, source_system, external_req_id)
// uniqueness would leak.

describe('source_system canonicalization (pure)', () => {
  it('normalizes to a deterministic trimmed lowercase key', () => {
    expect(normalizeSourceSystem('Fieldglass')).toBe('fieldglass');
    expect(normalizeSourceSystem('  BEELINE  ')).toBe('beeline');
    expect(normalizeSourceSystem('workday_vndly')).toBe('workday_vndly');
    // Idempotent — normalizing a canonical key is a no-op.
    expect(normalizeSourceSystem(normalizeSourceSystem('Coupa'))).toBe('coupa');
  });

  it('accepts canonical lowercase provider keys', () => {
    for (const key of ['manual', 'fieldglass', 'beeline', 'oracle', 'coupa', 'workday_vndly', 'api2']) {
      expect(isCanonicalSourceSystemKey(key)).toBe(true);
    }
  });

  it('rejects malformed keys (blank, spaces, punctuation, uppercase, over-length)', () => {
    expect(isCanonicalSourceSystemKey('')).toBe(false);
    expect(isCanonicalSourceSystemKey('field glass')).toBe(false);
    expect(isCanonicalSourceSystemKey('field-glass')).toBe(false);
    expect(isCanonicalSourceSystemKey('Fieldglass')).toBe(false); // not yet normalized
    expect(isCanonicalSourceSystemKey('drop;table')).toBe(false);
    expect(isCanonicalSourceSystemKey('a'.repeat(MAX_SOURCE_SYSTEM_LENGTH + 1))).toBe(false);
  });
});

describe('resolveExternalIdentity (throwing repository-facing validator)', () => {
  const rid = 'req-A';

  it('returns nulls when no provenance supplied (ordinary manual requisition)', () => {
    expect(resolveExternalIdentity({}, rid)).toEqual({ source_system: null, external_req_id: null });
    expect(resolveExternalIdentity({ source_system: null, external_req_id: null }, rid)).toEqual({
      source_system: null,
      external_req_id: null,
    });
  });

  it('canonicalizes a supplied source_system', () => {
    expect(resolveExternalIdentity({ source_system: 'Fieldglass', external_req_id: 'REQ-9' }, rid)).toEqual({
      source_system: 'fieldglass',
      external_req_id: 'REQ-9',
    });
  });

  it('allows a source_system alone (tagged origin, no external id)', () => {
    expect(resolveExternalIdentity({ source_system: 'manual' }, rid)).toEqual({
      source_system: 'manual',
      external_req_id: null,
    });
  });

  it('rejects a malformed source_system with VALIDATION_ERROR (400)', () => {
    expectValidationError(() => resolveExternalIdentity({ source_system: 'field glass' }, rid));
  });

  it('rejects a blank external_req_id', () => {
    expectValidationError(() =>
      resolveExternalIdentity({ source_system: 'fieldglass', external_req_id: '   ' }, rid),
    );
  });

  it('rejects external_req_id without a source_system (partial external identity)', () => {
    expectValidationError(() => resolveExternalIdentity({ external_req_id: 'REQ-9' }, rid));
  });

  it('trims a supplied external_req_id but preserves its case (opaque provider id)', () => {
    expect(resolveExternalIdentity({ source_system: 'beeline', external_req_id: '  Req-AbC-1  ' }, rid)).toEqual({
      source_system: 'beeline',
      external_req_id: 'Req-AbC-1',
    });
  });
});
